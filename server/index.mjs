// Serves the built UI and discovers the Sendspin server (Music Assistant) via mDNS.
// Browsers cannot browse mDNS, so the TV asks this server at GET /api/server.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bonjour } from 'bonjour-service';

const PORT = Number(process.env.PORT) || 8080;
const ROOT = resolve(process.env.STATIC_DIR || join(fileURLToPath(import.meta.url), '../../dist'));
const REQUERY_MS = 30000;
const ART_TIMEOUT_MS = 8000;
const ART_MAX_BYTES = 8 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

// Keyed by mDNS instance name.
const servers = new Map();

function toEntry(service) {
  const txt = service.txt || {};
  const addresses = service.addresses || [];
  // TVs often cannot resolve .local names, so prefer a literal IPv4 address.
  const host = addresses.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) || service.host;
  const path = txt.path || '/sendspin';
  return {
    name: txt.name || service.name,
    host,
    port: service.port,
    path,
    url: `ws://${host}:${service.port}${path.startsWith('/') ? path : '/' + path}`
  };
}

function startDiscovery() {
  const bonjour = new Bonjour();
  const browser = bonjour.find({ type: 'sendspin-server' });

  browser.on('up', (service) => {
    const entry = toEntry(service);
    servers.set(service.name, entry);
    console.log(`mDNS up: ${entry.name} -> ${entry.url}`);
  });
  browser.on('down', (service) => {
    servers.delete(service.name);
    console.log(`mDNS down: ${service.name}`);
  });

  setInterval(() => browser.update(), REQUERY_MS);
}

function currentServer() {
  return servers.values().next().value || null;
}

async function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = normalize(join(ROOT, urlPath === '/' ? 'index.html' : urlPath));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end();
    return;
  }
  try {
    if (!(await stat(file)).isFile()) throw new Error('not a file');
    const ext = extname(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'max-age=300'
    });
    res.end(await readFile(file));
  } catch (_) {
    res.writeHead(404).end('Not found');
  }
}

// Re-serves artwork from our own origin so the UI can read its pixels for
// colour extraction. Only http(s) URLs that return an image are passed on.
async function proxyArt(req, res) {
  let target;
  try {
    target = new URL(new URL(req.url, 'http://x').searchParams.get('url'));
    if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error('bad scheme');
  } catch (_) {
    res.writeHead(400).end();
    return;
  }
  try {
    const upstream = await fetch(target, { signal: AbortSignal.timeout(ART_TIMEOUT_MS) });
    const type = upstream.headers.get('content-type') || '';
    const length = Number(upstream.headers.get('content-length')) || 0;
    if (!upstream.ok || !type.startsWith('image/') || length > ART_MAX_BYTES) throw new Error('rejected');
    const body = Buffer.from(await upstream.arrayBuffer());
    if (body.length > ART_MAX_BYTES) throw new Error('too large');
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'max-age=3600' });
    res.end(body);
  } catch (_) {
    res.writeHead(502).end();
  }
}

createServer((req, res) => {
  if (req.url.startsWith('/api/art')) {
    proxyArt(req, res);
    return;
  }
  if (req.url.startsWith('/api/server')) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ server: currentServer(), servers: [...servers.values()] }));
    return;
  }
  serveStatic(req, res);
}).listen(PORT, () => console.log(`Serving ${ROOT} on :${PORT}`));

startDiscovery();
