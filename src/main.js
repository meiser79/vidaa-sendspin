import { SendspinPlayer } from '@sendspin/sendspin-js';

const $ = (id) => document.getElementById(id);

const DISCOVERY_ENDPOINT = 'api/server';
const DEFAULT_PORT = 8927;
const DEFAULT_PATH = '/sendspin';
const RETRY_DELAY_MS = 5000;
const PAIRED_KEY = 'vidaa-sendspin-paired';

let player = null;
let server = null;
let lastState = null;
let retryTimer = null;
let startSeq = 0;
let lastMetadataDebug = '';
let lastFocusBeforeSettings = null;

// ---------------------------------------------------------------------------
// Helpers

function log(message) {
  const line = `[${new Date().toLocaleTimeString('de-DE', { hour12: false })}] ${message}`;
  console.log(line);
  const el = $('debugLog');
  el.textContent += line + '\n';
  // Keep the on-screen log bounded on long-running TVs.
  if (el.textContent.length > 20000) el.textContent = el.textContent.slice(-15000);
  el.scrollTop = el.scrollHeight;
}

function storageGet(key) {
  try { return localStorage.getItem(key); } catch (_) { return null; }
}
function storageSet(key, value) {
  try { localStorage.setItem(key, value); } catch (_) {}
}

function formatTime(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0:00';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function formatPin(pin) {
  const p = String(pin || '');
  if (p.length === 6) return p.slice(0, 3) + ' ' + p.slice(3);
  if (p.length === 8) return p.slice(0, 4) + ' ' + p.slice(4);
  return p;
}

function setArt(el, url) {
  if (url) {
    el.style.backgroundImage = `url("${String(url).replace(/"/g, '\\"')}")`;
    el.classList.add('has-art');
  } else {
    el.style.backgroundImage = '';
    el.classList.remove('has-art');
  }
}

// ---------------------------------------------------------------------------
// Status

function setConnection(text, mode) {
  $('connectionText').textContent = text;
  $('connectionDot').className = 'dot ' + (mode || '');
  const notice = $('notice');
  if (mode === 'ok') {
    notice.classList.remove('show');
  } else {
    notice.textContent = mode === 'bad' ? text + ' — retrying…' : 'Looking for Music Assistant on your network…';
    notice.classList.add('show');
  }
}

function updateServerInfo() {
  $('serverName').textContent = server ? server.name || server.host : '—';
  $('serverUrl').textContent = server ? server.url.replace(/^wss?:\/\//, '') : '—';
  $('clientId').textContent = player?.clientId || '—';
}

function updateSyncInfo() {
  const el = $('syncInfo');
  if (!player || !player.isConnected) {
    el.textContent = '—';
  } else if (!player.timeSyncInfo?.synced) {
    el.textContent = 'Syncing…';
  } else {
    const err = player.syncInfo?.syncErrorMs;
    el.textContent = Number.isFinite(err)
      ? `±${Math.abs(err) < 10 ? Math.abs(err).toFixed(1) : Math.round(Math.abs(err))} ms`
      : 'Synced';
  }
}

// ---------------------------------------------------------------------------
// Now playing

function updatePlayerState(state) {
  lastState = state;

  const playing = !!state?.isPlaying;
  $('iconPlay').style.display = playing ? 'none' : 'block';
  $('iconPause').style.display = playing ? 'block' : 'none';

  const volume = Number.isFinite(state?.volume) ? Math.round(state.volume) : 0;
  const muted = !!state?.muted;
  if (document.activeElement !== $('volumeSlider')) $('volumeSlider').value = volume;
  $('volumeValue').textContent = muted ? 'Muted' : volume + '%';
  $('volWaves').style.display = muted ? 'none' : '';
  $('volMuted').style.display = muted ? '' : 'none';

  const meta = state?.serverState?.metadata || {};
  $('trackTitle').textContent = meta.title || 'Nothing playing';
  $('trackArtist').textContent = meta.artist || '';
  $('trackAlbum').textContent = [meta.album, meta.year].filter(Boolean).join(' · ');
  setArt($('albumArt'), meta.artwork_url);
  setArt($('backdrop'), meta.artwork_url);

  $('shuffle').classList.toggle('on', !!meta.shuffle);
  const repeat = meta.repeat || 'off';
  $('repeat').classList.toggle('on', repeat !== 'off');
  $('repeat').classList.toggle('repeat-one', repeat === 'one');

  const group = state?.groupState?.group_name;
  $('groupName').textContent = group ? ' · ' + group : '';

  const metadataDebug = JSON.stringify(meta);
  if (metadataDebug !== '{}' && metadataDebug !== lastMetadataDebug) {
    lastMetadataDebug = metadataDebug;
    log('Metadata: ' + metadataDebug);
  }
}

function updateProgress() {
  const progress = player?.trackProgress;
  const duration = progress?.durationMs || 0;
  const position = Math.min(progress?.positionMs || 0, duration || Infinity);
  $('progressFill').style.width = duration ? (position / duration * 100).toFixed(2) + '%' : '0';
  $('timeElapsed').textContent = formatTime(position);
  $('timeTotal').textContent = duration ? formatTime(duration) : '';
}

function updateQualityBadges() {
  const container = $('qualityBadges');
  const format = player?.currentFormat;
  const values = [];

  if (format) {
    const codec = String(format.codec || '').toLowerCase();
    if (codec) values.push(codec.toUpperCase());
    if (format.sample_rate > 0) {
      const khz = format.sample_rate / 1000;
      values.push((Number.isInteger(khz) ? khz : khz.toFixed(1)) + ' kHz');
    }
    // bit_depth is meaningful for PCM/FLAC, not Opus.
    if (format.bit_depth > 0 && codec !== 'opus') values.push(format.bit_depth + '-bit');
    if (format.channels === 1) values.push('Mono');
    else if (format.channels === 2) values.push('Stereo');
    else if (format.channels > 2) values.push(format.channels + ' ch');
  }

  const key = values.join('|');
  if (container.dataset.key === key) return;
  container.dataset.key = key;
  // innerHTML/appendChild instead of replaceChildren for older VIDAA engines.
  container.innerHTML = '';
  values.forEach((value) => {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = value;
    container.appendChild(badge);
  });
}

function send(command) {
  if (!player) return;
  try {
    player.sendCommand(command);
    log('Command: ' + command);
  } catch (err) {
    log('Command error: ' + err);
  }
}

// ---------------------------------------------------------------------------
// Pairing

function setPairing(status, pin) {
  $('pairStatus').textContent = status;
  const pinEl = $('pairPin');
  pinEl.textContent = pin ? formatPin(pin) : 'No PIN requested';
  pinEl.classList.toggle('empty', !pin);
}

function initialPairingStatus() {
  return storageGet(PAIRED_KEY) ? 'Paired' : 'Not paired yet';
}

// ---------------------------------------------------------------------------
// Discovery & connection

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
  ]);
}

async function discoverViaApi() {
  const res = await withTimeout(fetch(DISCOVERY_ENDPOINT, { cache: 'no-store' }), 4000);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  return data.server || null;
}

// Without the discovery service (e.g. plain static hosting) assume the UI is
// served from the Music Assistant host itself and try its default port.
function probeSameHost() {
  const host = window.location.hostname;
  if (!host) return Promise.resolve(null);
  const url = `ws://${host}:${DEFAULT_PORT}${DEFAULT_PATH}`;
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { ws.close(); } catch (_) {}
      resolve(ok ? { name: host, host, port: DEFAULT_PORT, path: DEFAULT_PATH, url } : null);
    };
    const ws = new WebSocket(url);
    ws.onopen = () => finish(true);
    ws.onerror = () => finish(false);
    setTimeout(() => finish(false), 3000);
  });
}

async function discover() {
  try {
    return await discoverViaApi();
  } catch (err) {
    log('Discovery service unavailable (' + (err.message || err) + '), probing page host');
    return probeSameHost();
  }
}

function teardown() {
  if (!player) return;
  try { player.disconnect('restart'); } catch (_) {}
  player = null;
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(start, RETRY_DELAY_MS);
}

function createPlayer(target) {
  const config = {
    clientName: 'VIDAA TV',
    productName: 'VIDAA Sendspin',
    correctionMode: 'sync',
    unpairedAccess: true,
    pinOutChannels: ['display'],
    minPinLength: 6,

    onPairingPin: (pin) => {
      log('Pairing PIN ' + (pin ? 'received' : 'cleared'));
      setPairing(pin ? 'Enter this PIN in Music Assistant' : $('pairStatus').textContent, pin);
      if (pin) openSettings($('cancelPairing'));
    },

    onPairing: (event, detail) => {
      log(`Pairing: ${event}${detail ? ' ' + detail : ''}`);
      if (event === 'pending') {
        setPairing('Music Assistant wants to pair. Press “Allow pairing”.');
        openSettings($('openPairing'));
      } else if (event === 'started') {
        setPairing('Pairing in progress…', null);
      } else if (event === 'finalized') {
        storageSet(PAIRED_KEY, '1');
        setPairing('Paired', null);
        setTimeout(closeSettings, 2500);
      } else if (event === 'aborted') {
        setPairing('Pairing aborted' + (detail ? ` (${detail})` : ''), null);
      }
    },

    onStateChange: updatePlayerState,

    reconnect: {
      maxAttempts: 5,
      onReconnecting: (attempt) => setConnection(`Reconnecting (${attempt})…`, 'warn'),
      onReconnected: () => setConnection('Connected', 'ok'),
      onExhausted: () => {
        log('Reconnect exhausted, rediscovering server');
        teardown();
        start();
      }
    }
  };

  // The SDK appends /sendspin to baseUrl; only use it (and its auto-reconnect)
  // when the advertised path is the standard one.
  if (/\/sendspin\/?$/.test(target.path || DEFAULT_PATH)) {
    config.baseUrl = `http://${target.host}:${target.port}${target.path || DEFAULT_PATH}`;
  } else {
    const ws = new WebSocket(target.url);
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('close', () => { if (player) { teardown(); scheduleRetry(); } });
    config.webSocket = ws;
  }
  return new SendspinPlayer(config);
}

async function start() {
  // A newer start() (e.g. "Search again") supersedes any attempt in flight.
  const seq = ++startSeq;
  clearTimeout(retryTimer);
  teardown();
  setConnection('Searching…', 'warn');

  const found = await discover();
  if (seq !== startSeq) return;
  server = found;
  updateServerInfo();
  if (!server) {
    log('No Sendspin server found, retrying');
    setConnection('No server found', 'bad');
    scheduleRetry();
    return;
  }

  log(`Connecting to ${server.name || server.host} at ${server.url}`);
  setConnection('Connecting…', 'warn');
  try {
    const current = createPlayer(server);
    player = current;
    await current.unlock();
    await current.connect();
    if (seq !== startSeq) return;
    setConnection('Connected', 'ok');
    updateServerInfo();
    log(`Connected clientId=${player.clientId}`);
  } catch (err) {
    if (seq !== startSeq) return;
    log('Connect failed: ' + (err?.message || String(err)));
    teardown();
    setConnection('Connection failed', 'bad');
    scheduleRetry();
  }
}

// ---------------------------------------------------------------------------
// Settings drawer

function settingsOpen() {
  return document.body.classList.contains('settings-open');
}

function openSettings(focusTarget) {
  if (!settingsOpen()) {
    lastFocusBeforeSettings = document.activeElement;
    document.body.classList.add('settings-open');
    updateServerInfo();
  }
  requestAnimationFrame(() => setTvFocus(focusTarget || $('openPairing')));
}

function closeSettings() {
  if (!settingsOpen()) return;
  document.body.classList.remove('settings-open');
  const target = lastFocusBeforeSettings && isVisible(lastFocusBeforeSettings)
    ? lastFocusBeforeSettings
    : $('playPause');
  requestAnimationFrame(() => setTvFocus(target));
}

// ---------------------------------------------------------------------------
// Remote-control navigation

function isVisible(el) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && window.getComputedStyle(el).visibility !== 'hidden';
}

function getFocusable() {
  const scope = settingsOpen() ? $('settings') : document.querySelector('.screen');
  return Array.from(scope.querySelectorAll('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'))
    .filter(isVisible);
}

function setTvFocus(el) {
  if (!el) return;
  try { el.focus(); } catch (_) { return; }

  // VIDAA is inconsistent with scrollIntoView(), so scroll the drawer manually.
  const container = $('settingsBody');
  if (!container.contains(el)) return;
  const cr = container.getBoundingClientRect();
  const er = el.getBoundingClientRect();
  const margin = 32;
  if (er.bottom > cr.bottom - margin) container.scrollTop += er.bottom - cr.bottom + margin;
  else if (er.top < cr.top + margin) container.scrollTop -= cr.top - er.top + margin;
}

function moveFocus(direction) {
  const items = getFocusable();
  if (!items.length) return;

  const current = document.activeElement;
  if (!items.includes(current)) {
    setTvFocus(settingsOpen() ? items[0] : $('playPause'));
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
    const dx = b.left + b.width / 2 - ax;
    const dy = b.top + b.height / 2 - ay;
    let primary;
    let secondary;

    if (direction === 'left') { if (dx >= -2) continue; primary = -dx; secondary = Math.abs(dy); }
    else if (direction === 'right') { if (dx <= 2) continue; primary = dx; secondary = Math.abs(dy); }
    else if (direction === 'up') { if (dy >= -2) continue; primary = -dy; secondary = Math.abs(dx); }
    else { if (dy <= 2) continue; primary = dy; secondary = Math.abs(dx); }

    // Prefer elements mostly in the requested direction without trapping focus.
    const score = primary + secondary * 2.25;
    if (score < bestScore) { bestScore = score; best = el; }
  }

  if (best) setTvFocus(best);
}

// Left/Right only change the volume after OK is pressed on the slider, so
// focus can still move past it to the other controls.
function setAdjusting(input, on) {
  input.classList.toggle('adjusting', on);
}

function nudgeRange(input, delta) {
  input.value = Math.max(Number(input.min || 0), Math.min(Number(input.max || 100), Number(input.value) + delta));
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

// Scroll the debug log with Up/Down; leave it once its edge is reached.
function scrollLog(el, delta) {
  const before = el.scrollTop;
  el.scrollTop += delta;
  return el.scrollTop !== before;
}

function handleRemoteKey(event) {
  const code = event.keyCode || event.which || 0;
  const key = event.key || '';
  const active = document.activeElement;
  const isRange = active && active.tagName === 'INPUT' && active.type === 'range';
  const adjusting = isRange && active.classList.contains('adjusting');
  const isLog = active === $('debugLog');

  const handled = () => { event.preventDefault(); event.stopPropagation(); };

  if (code === 37 || key === 'ArrowLeft') { handled(); adjusting ? nudgeRange(active, -5) : moveFocus('left'); return; }
  if (code === 39 || key === 'ArrowRight') { handled(); adjusting ? nudgeRange(active, 5) : moveFocus('right'); return; }
  if (code === 38 || key === 'ArrowUp') { handled(); if (!(isLog && scrollLog(active, -80))) moveFocus('up'); return; }
  if (code === 40 || key === 'ArrowDown') { handled(); if (!(isLog && scrollLog(active, 80))) moveFocus('down'); return; }

  if (code === 13 || key === 'Enter') {
    handled();
    if (isRange) setAdjusting(active, !adjusting);
    else if (active && typeof active.click === 'function') active.click();
    return;
  }

  // VIDAA Back is VK_BACK_SPACE = 8; keep other common TV codes as fallbacks.
  if (code === 8 || code === 27 || code === 461 || code === 10009 || key === 'Backspace' || key === 'Escape' || key === 'BrowserBack') {
    handled();
    if (adjusting) setAdjusting(active, false);
    else if (settingsOpen()) closeSettings();
    else try { window.close(); } catch (_) {}
    return;
  }

  // Physical media keys documented by VIDAA.
  if (code === 415) { handled(); send('play'); return; }
  if (code === 19) { handled(); send('pause'); return; }
  if (code === 463) { handled(); send(lastState?.isPlaying ? 'pause' : 'play'); return; }
  if (code === 413) { handled(); send('stop'); return; }

  if (event.type === 'keydown') log('Unhandled key key=' + key + ' code=' + code);
}

function setupTvNavigation() {
  // Capture phase is intentional: some VIDAA shells consume navigation keys
  // before bubbling reaches document.
  let lastKeyDownAt = 0;
  window.addEventListener('keydown', (event) => {
    lastKeyDownAt = Date.now();
    // Any remote key press counts as a user gesture for the audio context.
    if (player) player.unlock().catch(() => {});
    handleRemoteKey(event);
  }, true);

  // Some firmware exposes remote keys only on keyup; use it as a fallback.
  window.addEventListener('keyup', (event) => {
    if (Date.now() - lastKeyDownAt > 250) handleRemoteKey(event);
  }, true);
}

// ---------------------------------------------------------------------------

function updateClock() {
  $('clock').textContent = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function initialize() {
  setupTvNavigation();

  $('openSettings').addEventListener('click', () => openSettings());
  $('closeSettings').addEventListener('click', closeSettings);
  document.querySelector('.scrim').addEventListener('click', closeSettings);
  $('reconnectBtn').addEventListener('click', start);

  $('playPause').addEventListener('click', () => send(lastState?.isPlaying ? 'pause' : 'play'));
  $('previous').addEventListener('click', () => send('previous'));
  $('next').addEventListener('click', () => send('next'));
  $('shuffle').addEventListener('click', () => {
    send(lastState?.serverState?.metadata?.shuffle ? 'unshuffle' : 'shuffle');
  });
  $('repeat').addEventListener('click', () => {
    const next = { off: 'repeat_all', all: 'repeat_one', one: 'repeat_off' };
    send(next[lastState?.serverState?.metadata?.repeat || 'off']);
  });

  $('volumeSlider').addEventListener('blur', (e) => setAdjusting(e.target, false));
  $('volumeSlider').addEventListener('input', (e) => {
    const vol = Number(e.target.value);
    if (player) try { player.setVolume(vol); } catch (_) {}
    $('volumeValue').textContent = vol + '%';
  });
  $('muteBtn').addEventListener('click', () => {
    if (player) try { player.setMuted(!lastState?.muted); } catch (_) {}
  });

  $('openPairing').addEventListener('click', () => {
    if (!player) return;
    try {
      player.openPairingWindow();
      setPairing('Pairing allowed for ~5 minutes. Start pairing in Music Assistant.');
      log('Pairing window opened');
    } catch (err) {
      log('openPairingWindow failed: ' + err);
    }
  });
  $('cancelPairing').addEventListener('click', () => {
    if (!player) return;
    try {
      player.cancelPairing();
      setPairing('Pairing cancelled', null);
      log('Pairing cancelled');
    } catch (err) {
      log('cancelPairing failed: ' + err);
    }
  });

  setInterval(() => {
    updateProgress();
    updateQualityBadges();
    updateSyncInfo();
  }, 500);
  setInterval(updateClock, 1000);

  updateClock();
  setPairing(initialPairingStatus(), null);
  requestAnimationFrame(() => setTvFocus($('playPause')));
  log('VIDAA Sendspin UI ready');
  start();
}

document.addEventListener('DOMContentLoaded', initialize);
