import { SendspinPlayer } from '@sendspin/sendspin-js';

const $ = (id) => document.getElementById(id);

let player = null;
let ws = null;
let lastState = null;
let dynamicPin = null;
let pairingStatus = 'Idle';
let autoConnectStarted = false;
let lastMetadataDebug = '';

const DEFAULT_WS = 'ws://homeassistant.lan:8927/sendspin';
const REQUIRED_LEAD_TIME_MS = 250;
const MIN_BUFFER_MS = 250;

function log(message) {
  const line = `[${new Date().toLocaleTimeString('de-DE', { hour12: false })}] ${message}`;
  console.log(line);
  const el = $('debugLog');
  if (el) {
    el.textContent += line + '\n';
    el.scrollTop = el.scrollHeight;
  }
}

function safeStorageGet(key, fallback) {
  try { return localStorage.getItem(key) || fallback; } catch (_) { return fallback; }
}
function safeStorageSet(key, value) {
  try { localStorage.setItem(key, value); } catch (_) {}
}

function setConnectionState(text, mode = '') {
  $('connectionText').textContent = text;
  $('connectionDot').className = 'dot ' + mode;
}

function setView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(v => v.classList.remove('active'));

  const view = $('view-' + name);
  const nav = document.querySelector(`.nav-item[data-view="${name}"]`);

  if (view) view.classList.add('active');
  if (nav) nav.classList.add('active');

  focusDefaultForView(name);
}

function attachNavigation() {
  document.querySelectorAll('.nav-item[data-view]').forEach(btn => {
    btn.addEventListener('click', () => setView(btn.dataset.view));
  });
}

function send(command, payload) {
  if (!player) return;
  try {
    player.sendCommand(command, payload);
    log('Command: ' + command);
  } catch (err) {
    log('Command error: ' + err);
  }
}

function updatePairingUi() {
  $('pairClientId').textContent = player?.clientId || '—';
  $('pairPin').textContent = formatPin(dynamicPin);
  $('pairStatus').textContent = pairingStatus;
}

function updatePlayerState(state) {
  lastState = state;

  updateQualityBadges();

  const playing = !!state?.isPlaying;
  const volume = Number.isFinite(state?.volume) ? state.volume : 0;
  const muted = !!state?.muted;

  const playIcon = $('playIcon');
  const pauseIcon = $('pauseIcon');
  if (playIcon) playIcon.style.display = playing ? 'none' : 'block';
  if (pauseIcon) pauseIcon.style.display = playing ? 'block' : 'none';
  $('volumeValue').textContent = muted ? 'Muted' : Math.round(volume) + '%';
  $('volumeSlider').value = volume;
  $('footerVolume').textContent = muted ? 'Muted' : Math.round(volume) + '%';

  const serverState = state?.serverState || {};
  const rawMetadata = serverState.metadata || serverState.media || serverState.track || {};
  const metadata = rawMetadata.metadata || rawMetadata;

  const title = metadata.title || metadata.name || metadata.track_name || serverState.title || 'Nothing playing';
  const artist = metadata.artist || metadata.artist_name ||
    (Array.isArray(metadata.artists) ? metadata.artists.join(', ') : '') ||
    serverState.artist || 'Music Assistant';
  const album = metadata.album || metadata.album_name || serverState.album || '';

  const trackTitleEl = $('trackTitle');
  const trackArtistEl = $('trackArtist');
  const trackAlbumEl = $('trackAlbum');
  if (trackTitleEl) trackTitleEl.textContent = title;
  if (trackArtistEl) trackArtistEl.textContent = artist;
  if (trackAlbumEl) trackAlbumEl.textContent = album;

  try {
    const metadataDebug = JSON.stringify(rawMetadata);
    if (metadataDebug && metadataDebug !== '{}' && metadataDebug !== lastMetadataDebug) {
      lastMetadataDebug = metadataDebug;
      log('Metadata: ' + metadataDebug);
    }
  } catch (_) {}

  const art = metadata.image_url || metadata.image || metadata.artwork_url ||
    metadata.artwork || metadata.thumbnail || metadata.album_art_uri ||
    serverState.image_url || '';
  const artEls = [$('albumArt')];
  artEls.forEach(el => {
    if (!el) return;
    if (art) {
      el.style.backgroundImage = `url("${String(art).replace(/"/g, '\\"')}")`;
      el.classList.add('has-art');
    } else {
      el.style.backgroundImage = '';
      el.classList.remove('has-art');
    }
  });

}


function formatSampleRate(sampleRate) {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return null;
  if (sampleRate % 1000 === 0) return (sampleRate / 1000) + ' kHz';
  return (sampleRate / 1000).toFixed(1).replace('.', ',') + ' kHz';
}

function formatChannels(channels) {
  if (!Number.isFinite(channels) || channels <= 0) return null;
  if (channels === 1) return 'Mono';
  if (channels === 2) return 'Stereo';
  return channels + ' ch';
}

function updateQualityBadges() {
  const container = $('qualityBadges');
  if (!container) return;

  const format = player?.currentFormat;
  if (!format) {
    container.replaceChildren();
    return;
  }

  const values = [];

  if (format.codec) {
    values.push(String(format.codec).toUpperCase());
  }

  const sampleRate = formatSampleRate(format.sample_rate);
  if (sampleRate) values.push(sampleRate);

  // bit_depth is meaningful for PCM/FLAC, not Opus.
  if (
    Number.isFinite(format.bit_depth) &&
    format.bit_depth > 0 &&
    String(format.codec || '').toLowerCase() !== 'opus'
  ) {
    values.push(format.bit_depth + '-bit');
  }

  const channels = formatChannels(format.channels);
  if (channels) values.push(channels);

  container.replaceChildren(
    ...values.map((value) => {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = value;
      return badge;
    })
  );
}

function updateSyncStatus() {
  const value = $('footerSync');
  const sub = $('footerSyncSub');
  if (!value || !sub) return;

  if (!player || !player.isConnected) {
    value.textContent = '—';
    sub.textContent = 'Disconnected';
    return;
  }

  const timeSync = player.timeSyncInfo;
  if (!timeSync?.synced) {
    value.textContent = 'Syncing…';
    sub.textContent = 'Clock sync pending';
    return;
  }

  const sync = player.syncInfo;
  if (Number.isFinite(sync?.syncErrorMs)) {
    const error = Math.abs(sync.syncErrorMs);
    value.textContent = `±${error < 10 ? error.toFixed(1) : Math.round(error)} ms`;
  } else {
    value.textContent = 'Synced';
  }

  const method = sync?.correctionMethod && sync.correctionMethod !== 'none'
    ? sync.correctionMethod
    : (sync?.correctionMode || player.correctionMode || 'sync');
  sub.textContent = `Correction: ${method}`;
}

function createPlayer(socket) {
  return new SendspinPlayer({
    webSocket: socket,
    clientName: 'VIDAA TV',
    productName: 'VIDAA Sendspin',
    correctionMode: 'sync',
    requiredLeadTimeMs: REQUIRED_LEAD_TIME_MS,
    minBufferMs: MIN_BUFFER_MS,
    unpairedAccess: true,

    pinOutChannels: ['display'],
    minPinLength: 6,

    onPairingPin: (pin, languages) => {
      dynamicPin = pin || null;
      log(`Pairing PIN: ${pin || 'hidden'} ${(languages || []).join(', ')}`);
      updatePairingUi();
      if (pin) setView('settings');
    },

    onPairing: (event, detail) => {
      const labels = {
        pending: 'Waiting for local approval',
        started: 'Pairing in progress',
        finalized: 'Paired',
        aborted: 'Pairing aborted'
      };
      pairingStatus = labels[event] || event || 'Idle';
      log(`Pairing: ${event} ${detail ? JSON.stringify(detail) : ''}`);
      updatePairingUi();
      if (event === 'pending' || event === 'started') setView('settings');
    },

    onStateChange: updatePlayerState
  });
}

async function connect() {
  const wsUrl = $('wsUrl').value.trim() || DEFAULT_WS;
  safeStorageSet('vidaa-sendspin-ws', wsUrl);

  $('connectBtn').disabled = true;
  setConnectionState('Connecting…', 'warn');

  try {
    if (player) {
      try { player.disconnect('user_request'); } catch (_) {}
      player = null;
    }
    if (ws) {
      try { ws.close(); } catch (_) {}
      ws = null;
    }

    ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    ws.addEventListener('open', () => log('WebSocket OPEN'));
    ws.addEventListener('error', () => log('WebSocket ERROR'));
    ws.addEventListener('close', (ev) => {
      log(`WebSocket CLOSE code=${ev.code} reason=${JSON.stringify(ev.reason || '')} clean=${ev.wasClean}`);
      setConnectionState('Disconnected', 'bad');
      $('connectBtn').disabled = false;
      $('disconnectBtn').disabled = true;
      updateSyncStatus();
    });

    player = createPlayer(ws);

    // Keep unlock first in the user gesture.
    await player.unlock();
    await player.connect();

    setConnectionState('Connected', 'ok');
    $('connectBtn').disabled = true;
    $('disconnectBtn').disabled = false;
    $('footerServer').textContent = 'Music Assistant · ' + wsUrl.replace(/^wss?:\/\//, '');

    updatePairingUi();
    updateQualityBadges();
    updateSyncStatus();
    log(`Connected clientId=${player.clientId || 'unknown'}`);
  } catch (err) {
    setConnectionState('Error', 'bad');
    $('connectBtn').disabled = false;
    $('disconnectBtn').disabled = true;
    log('CONNECT ERROR: ' + (err?.stack || String(err)));
  }
}

function disconnect() {
  if (player) {
    try { player.disconnect('user_request'); } catch (_) {}
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.close(1000, 'user_request'); } catch (_) {}
  }
  player = null;
  ws = null;
  setConnectionState('Disconnected', 'bad');
  $('connectBtn').disabled = false;
  $('disconnectBtn').disabled = true;
  updatePairingUi();
  updateQualityBadges();
}

async function copyText(text) {
  if (!text || text === 'Nicht verfügbar' || text === '—') return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    $('copyToast').classList.add('show');
    setTimeout(() => $('copyToast').classList.remove('show'), 1300);
  } catch (err) {
    log('Copy failed: ' + err);
  }
}

function formatPin(pin) {
  const p = String(pin || '');
  if (p.length === 6) return p.slice(0, 3) + '-' + p.slice(3);
  if (p.length === 8) return p.slice(0, 4) + '-' + p.slice(4);
  return p || '—';
}


function isElementVisible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function getFocusableElements() {
  return Array.from(document.querySelectorAll(
    'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )).filter((el) => isElementVisible(el));
}

function ensureVisibleInSettings(el) {
  if (!el) return;
  var container = el.closest ? el.closest('.settings-main') : null;
  if (!container) return;

  var cr = container.getBoundingClientRect();
  var er = el.getBoundingClientRect();
  var margin = 32;

  if (er.bottom > cr.bottom - margin) {
    container.scrollTop += er.bottom - cr.bottom + margin;
  } else if (er.top < cr.top + margin) {
    container.scrollTop -= cr.top - er.top + margin;
  }

  // The focusable settingsEnd element below Debug Log lets D-pad Down
  // move into the bottom breathing room and forces VIDAA to reveal it.
  if (el.id === 'settingsEnd') {
    container.scrollTop = container.scrollHeight - container.clientHeight;
  }
}

function setTvFocus(el) {
  document.querySelectorAll('.tv-focus').forEach((node) => node.classList.remove('tv-focus'));
  if (!el) return;
  try {
    el.focus();
  } catch (err) {
    log('Focus failed: ' + String(err));
    return;
  }
  el.classList.add('tv-focus');

  // VIDAA WebApps are inconsistent with scrollIntoView(), so scroll
  // our own Settings/About container explicitly first.
  ensureVisibleInSettings(el);

  // Fallback for non-Settings elements / other browsers.
  if (!(el.closest && el.closest('.settings-main'))) {
    try { el.scrollIntoView(false); } catch (_) {}
  }
}

function focusDefaultForView(viewName) {
  requestAnimationFrame(() => {
    let target = null;

    if (viewName === 'now') {
      target = $('playPause');
    } else if (viewName === 'settings') {
      target = $('wsUrl') || $('connectBtn');
    } else if (viewName === 'about') {
      target = document.querySelector('.nav-item[data-view="about"]');
    }

    if (!target || !isElementVisible(target)) {
      target = getFocusableElements()[0] || null;
    }

    setTvFocus(target);
  });
}

function moveFocus(direction) {
  const items = getFocusableElements();
  if (!items.length) return;

  let current = document.activeElement;
  if (!items.includes(current)) {
    setTvFocus(items[0]);
    return;
  }

  const a = current.getBoundingClientRect();
  const ax = a.left + a.width / 2;
  const ay = a.top + a.height / 2;

  let best = null;
  let bestScore = Infinity;

  for (const el of items) {
    if (el === current) continue;

    const b = el.getBoundingClientRect();
    const bx = b.left + b.width / 2;
    const by = b.top + b.height / 2;
    const dx = bx - ax;
    const dy = by - ay;

    let primary;
    let secondary;

    if (direction === 'left') {
      if (dx >= -2) continue;
      primary = -dx;
      secondary = Math.abs(dy);
    } else if (direction === 'right') {
      if (dx <= 2) continue;
      primary = dx;
      secondary = Math.abs(dy);
    } else if (direction === 'up') {
      if (dy >= -2) continue;
      primary = -dy;
      secondary = Math.abs(dx);
    } else {
      if (dy <= 2) continue;
      primary = dy;
      secondary = Math.abs(dx);
    }

    // Prefer elements that are mostly in the requested direction.
    // Secondary-axis drift is penalized, but not enough to trap focus.
    const score = primary + secondary * 2.25;

    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }

  if (best) setTvFocus(best);
}

function handleTvBack() {
  const activeView = document.querySelector('.view.active')?.id?.replace('view-', '') || 'now';

  if (activeView !== 'now') {
    setView('now');
    focusDefaultForView('now');
    return;
  }

  // On the main screen, let VIDAA close the app if supported.
  try {
    window.close();
  } catch (_) {}
}

function setupTvNavigation() {
  document.addEventListener('focusin', function (event) {
    document.querySelectorAll('.tv-focus').forEach(function (node) {
      if (node !== event.target) node.classList.remove('tv-focus');
    });
    if (event.target && event.target.classList) {
      event.target.classList.add('tv-focus');
    }
  });

  function handleRemoteKey(event) {
    var code = event.keyCode || event.which || 0;
    var key = event.key || '';

    // Debug every remote key so VIDAA-specific codes are visible in Settings.
    if (code || key) {
      log('KEY key=' + key + ' code=' + code);
    }

    var active = document.activeElement;
    var isRange = active && active.tagName === 'INPUT' && active.type === 'range';

    if (code === 37 || key === 'ArrowLeft') {
      event.preventDefault();
      event.stopPropagation();
      if (isRange) {
        var leftValue = Math.max(Number(active.min || 0), Number(active.value) - 5);
        active.value = leftValue;
        active.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        moveFocus('left');
      }
      return false;
    }

    if (code === 39 || key === 'ArrowRight') {
      event.preventDefault();
      event.stopPropagation();
      if (isRange) {
        var rightValue = Math.min(Number(active.max || 100), Number(active.value) + 5);
        active.value = rightValue;
        active.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        moveFocus('right');
      }
      return false;
    }

    if (code === 38 || key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      moveFocus('up');
      return false;
    }

    if (code === 40 || key === 'ArrowDown') {
      event.preventDefault();
      event.stopPropagation();
      moveFocus('down');
      return false;
    }

    if (code === 13 || key === 'Enter' || key === 'OK') {
      event.preventDefault();
      event.stopPropagation();

      if (active && active.tagName === 'INPUT' && active.type === 'text') {
        try { active.blur(); } catch (_) {}
        return false;
      }

      if (active && typeof active.click === 'function') {
        active.click();
      }
      return false;
    }

    // VIDAA Back/Return is VK_BACK_SPACE = 8.
    // Keep additional common TV codes as fallbacks.
    if (
      code === 8 ||
      code === 27 ||
      code === 461 ||
      code === 10009 ||
      key === 'Backspace' ||
      key === 'Escape' ||
      key === 'BrowserBack'
    ) {
      event.preventDefault();
      event.stopPropagation();
      handleTvBack();
      return false;
    }

    // Physical media keys documented by VIDAA.
    if (code === 415) { // PLAY
      event.preventDefault();
      send('play');
      return false;
    }
    if (code === 19) { // PAUSE
      event.preventDefault();
      send('pause');
      return false;
    }
    if (code === 463) { // PLAY_PAUSE
      event.preventDefault();
      send(lastState?.isPlaying ? 'pause' : 'play');
      return false;
    }
    if (code === 413) { // STOP
      event.preventDefault();
      send('stop');
      return false;
    }
  }

  // Capture phase is intentional: some VIDAA shells/browser layers consume
  // navigation keys before bubbling reaches document.
  window.addEventListener('keydown', handleRemoteKey, true);

  // Some firmware/browser combinations expose the same remote controls on keyup.
  // Only use keyup as fallback when no keydown has been seen recently.
  var lastKeyDownAt = 0;
  window.addEventListener('keydown', function () {
    lastKeyDownAt = Date.now();
  }, true);

  window.addEventListener('keyup', function (event) {
    if (Date.now() - lastKeyDownAt > 250) {
      handleRemoteKey(event);
    }
  }, true);

  focusDefaultForView('now');
}

function initialize() {
  $('wsUrl').value = safeStorageGet('vidaa-sendspin-ws', DEFAULT_WS);
  $('footerServer').textContent = 'Music Assistant · ' + $('wsUrl').value.replace(/^wss?:\/\//, '');

  attachNavigation();
  setupTvNavigation();

  $('connectBtn').addEventListener('click', connect);
  $('disconnectBtn').addEventListener('click', disconnect);

  $('playPause').addEventListener('click', () => send(lastState?.isPlaying ? 'pause' : 'play'));
  $('previous').addEventListener('click', () => send('previous'));
  $('next').addEventListener('click', () => send('next'));
  $('shuffle').addEventListener('click', () => send('shuffle'));
  $('repeat').addEventListener('click', () => send('repeat_all'));

  $('volumeSlider').addEventListener('input', (e) => {
    const vol = Number(e.target.value);
    if (player) {
      try { player.setVolume(vol); } catch (_) {}
    }
    $('volumeValue').textContent = Math.round(vol) + '%';
    $('footerVolume').textContent = Math.round(vol) + '%';
  });

  $('muteBtn').addEventListener('click', () => {
    if (!player) return;
    try { player.setMuted(!lastState?.muted); } catch (_) {}
  });
  $('copyClientId').addEventListener('click', () => copyText(player?.clientId));
  $('copyPin').addEventListener('click', () => copyText(dynamicPin));

  $('openPairing').addEventListener('click', () => {
    if (!player) return;
    try {
      player.openPairingWindow();
      pairingStatus = 'Pairing window open (~5 min)';
      updatePairingUi();
      log('Pairing window opened');
    } catch (err) {
      log('openPairingWindow failed: ' + err);
    }
  });

  $('cancelPairing').addEventListener('click', () => {
    if (!player) return;
    try {
      player.cancelPairing();
      dynamicPin = null;
      pairingStatus = 'Pairing cancelled';
      updatePairingUi();
      log('Pairing cancelled');
    } catch (err) {
      log('cancelPairing failed: ' + err);
    }
  });

  setInterval(() => {
    updateQualityBadges();
    updateSyncStatus();
  }, 500);

  setInterval(() => {
    $('clock').textContent = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', hour12: false });
  }, 1000);

  $('clock').textContent = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', hour12: false });
  updatePairingUi();
  updateSyncStatus();
  setView('now');
  log('VIDAA Sendspin UI ready');

  // Auto-connect once on app startup.
  if (!autoConnectStarted) {
    autoConnectStarted = true;
    setTimeout(() => {
      log('Auto-connect starting...');
      connect();
    }, 250);
  }
}

document.addEventListener('DOMContentLoaded', initialize);
