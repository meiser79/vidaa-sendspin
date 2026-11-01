import { SendspinPlayer } from '@sendspin/sendspin-js';

const $ = (id) => document.getElementById(id);

const DISCOVERY_ENDPOINT = 'api/server';
const DEFAULT_PORT = 8927;
const DEFAULT_PATH = '/sendspin';
const RETRY_DELAY_MS = 5000;
const PAIRED_KEY = 'vidaa-sendspin-paired';
const SEEK_STEP_MS = 10000;
// Repeated Left/Right presses accumulate; the seek is sent once they stop.
const SEEK_COMMIT_DELAY_MS = 700;
// Keep showing the target until the server's progress catches up.
const SEEK_HOLD_MS = 1500;
// Controls fade out after this long without a remote key press.
const IDLE_MS = 5000;
// While paused this long without input, dim the screen and drift the layout.
const DIM_AFTER_MS = 2 * 60 * 1000;
const DRIFT_EVERY_MS = 60 * 1000;
const ART_PROXY = 'api/art?url=';
// Neutral graphite: used without artwork and for black-and-white artwork.
const NEUTRAL_PALETTE = { accent: '#e6e9f0', glowA: 'hsl(220,8%,20%)', glowB: 'hsl(220,8%,12%)' };
// A track change waits this long at most for artwork and colours to load.
const TRACK_SWAP_TIMEOUT_MS = 3000;
const PALETTE_CACHE_SIZE = 30;
// Reveal the screen at the latest after this long, even without a track.
const BOOT_TIMEOUT_MS = 4000;

let player = null;
let server = null;
let lastState = null;
let retryTimer = null;
let startSeq = 0;
let lastMetadataDebug = '';
let lastFocusBeforeSettings = null;
let seekTarget = null;
let seekCommitTimer = null;
let seekHoldTimer = null;
let idleTimer = null;
let focusBeforeIdle = null;
let paletteUrl;
let backdropLayer = 0;
let artUrl;
let artLayer = 0;
let trackKey = null;
let wantedTrackKey = null;
const paletteCache = new Map();
let lastInputAt = Date.now();
let pausedSince = null;
let driftTimer = null;

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

// Resolves with the loaded image, or null if there is none or it failed.
function loadImage(src) {
  return new Promise((resolve) => {
    if (!src) {
      resolve(null);
      return;
    }
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

// Crossfades to the new artwork (preloaded by updateTrack).
function setArtwork(url) {
  if (url === artUrl) return;
  artUrl = url;
  const art = $('albumArt');
  const layers = art.querySelectorAll('.art-layer');
  artLayer = 1 - artLayer;
  const next = layers[artLayer];
  next.style.backgroundImage = url ? `url("${String(url).replace(/"/g, '\\"')}")` : '';
  next.classList.toggle('show', !!url);
  layers[1 - artLayer].classList.remove('show');
  art.classList.toggle('has-art', !!url);
}

// Updates title/artist/album and replays the rise animation on track change.
function setTrackText(title, artist, album) {
  const key = [title, artist, album].join('\u0000');
  if (key === trackKey) return;
  const first = trackKey === null;
  trackKey = key;
  $('trackTitle').textContent = title;
  $('trackArtist').textContent = artist;
  $('trackAlbum').textContent = album;
  if (first) return;
  ['trackTitle', 'trackArtist', 'trackAlbum'].forEach((id) => {
    const el = $(id);
    el.classList.remove('rise');
    void el.offsetWidth; // restart the animation
    el.classList.add('rise');
  });
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
  updateTrack(meta);

  $('shuffle').classList.toggle('on', !!meta.shuffle);
  const repeat = meta.repeat || 'off';
  $('repeat').classList.toggle('on', repeat !== 'off');
  $('repeat').classList.toggle('repeat-one', repeat === 'one');

  const metadataDebug = JSON.stringify(meta);
  if (metadataDebug !== '{}' && metadataDebug !== lastMetadataDebug) {
    lastMetadataDebug = metadataDebug;
    log('Metadata: ' + metadataDebug);
  }
}

function updateProgress() {
  const progress = player?.trackProgress;
  const duration = progress?.durationMs || 0;
  const previewing = seekTarget !== null;
  const position = previewing ? seekTarget : Math.min(progress?.positionMs || 0, duration || Infinity);
  $('progressFill').style.width = duration ? (position / duration * 100).toFixed(2) + '%' : '0';
  $('timeElapsed').textContent = formatTime(position);
  $('timeTotal').textContent = duration ? formatTime(duration) : '';
  $('seekBar').classList.toggle('previewing', previewing);
  $('timeElapsed').classList.toggle('previewing', previewing);

  const bar = $('seekBar');
  const seekable = canSeek() && duration > 0;
  bar.tabIndex = seekable ? 0 : -1;
}

// ---------------------------------------------------------------------------
// Seeking

function seekSupport() {
  const controller = lastState?.serverState?.controller || {};
  const commands = controller.supported_commands;
  return {
    // Without a command list, try 'seek' and let the server reject it.
    absolute: !commands || commands.includes('seek'),
    relative: !!commands && commands.includes('seek_relative'),
    maxMs: Number.isFinite(controller.seek_max_ms) ? controller.seek_max_ms : Infinity
  };
}

function canSeek() {
  const support = seekSupport();
  return !!player && (support.absolute || support.relative);
}

function previewSeek(targetMs) {
  const progress = player?.trackProgress;
  if (!canSeek() || !progress?.durationMs) return;
  const limit = Math.min(progress.durationMs, seekSupport().maxMs);
  seekTarget = Math.max(0, Math.min(limit, targetMs));
  clearTimeout(seekHoldTimer);
  clearTimeout(seekCommitTimer);
  seekCommitTimer = setTimeout(commitSeek, SEEK_COMMIT_DELAY_MS);
  updateProgress();
}

function seekBy(deltaMs) {
  const current = seekTarget !== null ? seekTarget : player?.trackProgress?.positionMs;
  if (Number.isFinite(current)) previewSeek(current + deltaMs);
}

// Sends the previewed position; a no-op unless a seek is still pending.
function commitSeek() {
  clearTimeout(seekCommitTimer);
  if (!seekCommitTimer || seekTarget === null) return;
  seekCommitTimer = null;
  const target = Math.round(seekTarget);
  if (seekSupport().absolute) {
    send('seek', { position_ms: target });
  } else {
    send('seek_relative', { offset_ms: target - Math.round(player?.trackProgress?.positionMs || 0) });
  }
  seekHoldTimer = setTimeout(() => { seekTarget = null; updateProgress(); }, SEEK_HOLD_MS);
}

// ---------------------------------------------------------------------------
// Artwork colours

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function hsl(h, s, l) {
  return `hsl(${Math.round(h)},${Math.round(s * 100)}%,${Math.round(l * 100)}%)`;
}

// Buckets the artwork's pixels by hue, weighted towards saturated mid-tones,
// and derives an accent plus two dark backdrop glows from the strongest hues.
function paletteFromImage(img) {
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, size, size);
  const data = ctx.getImageData(0, 0, size, size).data;

  const buckets = [];
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
    if (s < 0.18 || l < 0.12 || l > 0.9) continue;
    const key = Math.floor(h / 30) % 12;
    const weight = s * (1 - Math.abs(l - 0.5) * 1.4);
    const b = buckets[key] || (buckets[key] = { weight: 0, r: 0, g: 0, b: 0 });
    b.weight += weight;
    b.r += data[i] * weight;
    b.g += data[i + 1] * weight;
    b.b += data[i + 2] * weight;
  }

  const ranked = buckets
    .map((b, key) => b && { key, weight: b.weight, hsl: rgbToHsl(b.r / b.weight, b.g / b.weight, b.b / b.weight) })
    .filter(Boolean)
    .sort((a, b) => b.weight - a.weight);

  if (!ranked.length) return NEUTRAL_PALETTE;

  const first = ranked[0];
  const hueDistance = (a, b) => Math.min(Math.abs(a - b), 12 - Math.abs(a - b));
  const second = ranked.find((b) => hueDistance(b.key, first.key) >= 2) || first;
  const [h1, s1] = first.hsl;
  const [h2, s2] = second.hsl;
  return {
    accent: hsl(h1, clamp(s1, 0.5, 0.85), 0.64),
    glowA: hsl(h1, clamp(s1, 0.35, 0.7), 0.26),
    glowB: hsl(h2, clamp(s2, 0.3, 0.65), 0.17)
  };
}

function applyPalette(palette) {
  document.documentElement.style.setProperty('--accent', palette.accent);
  const layers = [$('backdropA'), $('backdropB')];
  backdropLayer = 1 - backdropLayer;
  const next = layers[backdropLayer];
  next.style.backgroundImage =
    `radial-gradient(ellipse 75% 85% at 15% 30%,${palette.glowA} 0,transparent 70%),` +
    `radial-gradient(ellipse 65% 75% at 88% 90%,${palette.glowB} 0,transparent 70%)`;
  next.classList.add('show');
  layers[1 - backdropLayer].classList.remove('show');
}

function setPalette(url, palette) {
  if (url === paletteUrl) return;
  paletteUrl = url;
  applyPalette(palette);
}

// The artwork is loaded through our own server so the canvas may read its
// pixels (artwork hosts rarely send CORS headers). Always resolves.
async function loadPalette(url) {
  if (!url) return NEUTRAL_PALETTE;
  if (paletteCache.has(url)) return paletteCache.get(url);
  const img = await loadImage(ART_PROXY + encodeURIComponent(url));
  let palette = NEUTRAL_PALETTE;
  if (img) {
    try {
      palette = paletteFromImage(img);
    } catch (err) {
      log('Palette failed: ' + err);
    }
  }
  if (paletteCache.size >= PALETTE_CACHE_SIZE) paletteCache.delete(paletteCache.keys().next().value);
  paletteCache.set(url, palette);
  return palette;
}

function finishBoot() {
  document.body.classList.remove('booting');
}

// Loads artwork and colours first, then switches text, artwork and colours
// in one go so the track change reads as a single transition.
function updateTrack(meta) {
  const title = meta.title || 'Nothing playing';
  const artist = meta.artist || '';
  const album = [meta.album, meta.year].filter(Boolean).join(' · ');
  const url = meta.artwork_url || null;
  const key = [title, artist, album, url].join('\u0000');
  if (key === wantedTrackKey) return;
  wantedTrackKey = key;

  const palette = loadPalette(url);
  const ready = Promise.all([loadImage(url), palette]);
  const timeout = new Promise((resolve) => setTimeout(resolve, TRACK_SWAP_TIMEOUT_MS));
  Promise.race([ready, timeout]).then(() => {
    if (key !== wantedTrackKey) return;
    setTrackText(title, artist, album);
    setArtwork(url);
    // Normally already resolved; after a timeout the colours follow later.
    palette.then((p) => {
      if (key !== wantedTrackKey) return;
      setPalette(url, p);
      if (meta.title) finishBoot();
    });
  });
}

function send(command, params) {
  if (!player) return;
  try {
    player.sendCommand(command, params);
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
    // Only paired servers may play; pair once via Settings.
    unpairedAccess: false,
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
  wake();
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
  wake();
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

// ---------------------------------------------------------------------------
// Idle mode: controls fade out, leaving artwork and metadata

function isIdle() {
  return document.body.classList.contains('idle');
}

function goIdle() {
  if (settingsOpen()) {
    wake();
    return;
  }
  // Blur so no focus ring is left on the visible progress bar; blur also ends
  // any volume/seek adjustment.
  focusBeforeIdle = document.activeElement;
  if (focusBeforeIdle && focusBeforeIdle.blur) focusBeforeIdle.blur();
  document.body.classList.add('idle');
}

// Shows the controls and restarts the idle timer. Returns true if the screen
// was idle, so the key press that woke it is not also acted on.
function wake() {
  lastInputAt = Date.now();
  undim();
  clearTimeout(idleTimer);
  idleTimer = setTimeout(goIdle, IDLE_MS);
  if (!isIdle()) return false;
  document.body.classList.remove('idle');
  const restorable = focusBeforeIdle && focusBeforeIdle !== document.body && document.body.contains(focusBeforeIdle);
  const target = restorable ? focusBeforeIdle : $('playPause');
  setTvFocus(target);
  return true;
}

function drift() {
  const x = (Math.random() * 2 - 1) * 2;
  const y = (Math.random() * 2 - 1) * 1.5;
  document.querySelector('.screen').style.transform = `translate(${x.toFixed(2)}rem,${y.toFixed(2)}rem)`;
}

function undim() {
  if (!document.body.classList.contains('dimmed')) return;
  document.body.classList.remove('dimmed');
  clearInterval(driftTimer);
  document.querySelector('.screen').style.transform = '';
}

// Called from the 500 ms tick: dims after DIM_AFTER_MS paused without input.
function updateDim() {
  if (lastState?.isPlaying || settingsOpen()) {
    pausedSince = null;
    undim();
    return;
  }
  if (pausedSince === null) pausedSince = Date.now();
  const quietFor = Date.now() - Math.max(pausedSince, lastInputAt);
  if (quietFor < DIM_AFTER_MS || document.body.classList.contains('dimmed')) return;
  document.body.classList.add('dimmed');
  drift();
  driftTimer = setInterval(drift, DRIFT_EVERY_MS);
}

function isMediaKey(code) {
  return code === 415 || code === 19 || code === 463 || code === 413;
}

function handleRemoteKey(event) {
  const code = event.keyCode || event.which || 0;
  const key = event.key || '';
  const active = document.activeElement;
  const isRange = active && active.tagName === 'INPUT' && active.type === 'range';
  const isSeek = active === $('seekBar');
  const adjusting = isRange && active.classList.contains('adjusting');
  const isLog = active === $('debugLog');

  const handled = () => { event.preventDefault(); event.stopPropagation(); };

  if (wake() && !isMediaKey(code)) { handled(); return; }

  if (code === 37 || key === 'ArrowLeft') {
    handled();
    if (isSeek) seekBy(-SEEK_STEP_MS);
    else adjusting ? nudgeRange(active, -5) : moveFocus('left');
    return;
  }
  if (code === 39 || key === 'ArrowRight') {
    handled();
    if (isSeek) seekBy(SEEK_STEP_MS);
    else adjusting ? nudgeRange(active, 5) : moveFocus('right');
    return;
  }
  if (code === 38 || key === 'ArrowUp') { handled(); if (!(isLog && scrollLog(active, -80))) moveFocus('up'); return; }
  if (code === 40 || key === 'ArrowDown') { handled(); if (!(isLog && scrollLog(active, 80))) moveFocus('down'); return; }

  if (code === 13 || key === 'Enter') {
    handled();
    if (isSeek) commitSeek();
    else if (isRange) setAdjusting(active, !adjusting);
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
  // Leaving the progress bar sends a seek that is still waiting.
  $('seekBar').addEventListener('blur', commitSeek);
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
    updateSyncInfo();
    updateDim();
  }, 500);
  document.addEventListener('mousemove', wake);
  setInterval(updateClock, 1000);

  updateClock();
  setPairing(initialPairingStatus(), null);
  setPalette(null, NEUTRAL_PALETTE);
  setTimeout(finishBoot, BOOT_TIMEOUT_MS);
  wake();
  requestAnimationFrame(() => setTvFocus($('playPause')));
  log('VIDAA Sendspin UI ready, build ' + __BUILD_ID__);
  start();
}

document.addEventListener('DOMContentLoaded', initialize);
