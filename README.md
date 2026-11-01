# VIDAA Sendspin

A Sendspin player for VIDAA TVs, running in the TV's browser and built on
[`sendspin/sendspin-js`](https://github.com/Sendspin/sendspin-js).

The TV becomes a synchronized Music Assistant speaker with a full-screen Now Playing display. The
Music Assistant server is discovered automatically, so there is nothing to configure — pair once and
it plays.

## Features

- **Now Playing screen**: large artwork, title, artist, album and year, with a live progress bar
- **Artwork colours**: accent colour and background glow are taken from the current cover; neutral
  graphite when there is no artwork
- **Auto-hiding controls**: shuffle, previous, play/pause, next, repeat and volume fade out after
  5 s without a key press; the next key press brings them back
- **Seeking** on the progress bar in 10 s steps
- **Track changes as one transition**: artwork and colours are loaded first, then the text rises
  while the artwork and background crossfade
- **Clean startup**: the screen stays dark until the first track is ready, then fades in
- **Burn-in protection**: after 2 minutes paused without input the screen dims and slowly drifts;
  any key restores it
- **Automatic server discovery** via mDNS, automatic reconnect and rediscovery if the server moves
- **Pairing required** before playback (unpaired access is disabled)
- **Settings drawer** (gear icon, top right) for pairing, connection status and a debug log
- Remote-control navigation (D-pad, OK, Back) and play/pause/stop media keys where available
- Bundled Inter font, so the TV needs no internet access
- App icon and web app manifest (installable on phones and computers)

## Quick start (Docker)

```bash
docker compose up -d --build
```

Then open `http://YOUR-SERVER-IP:8080/` on the VIDAA TV and pair it (see [Pairing](#pairing)).

The container must use **host networking** (already set in `docker-compose.yaml`): mDNS discovery
relies on multicast, which does not cross Docker's bridge network. The port can be changed with the
`PORT` environment variable (default `8080`).

## Pairing

Pairing is needed once per TV. Press the gear icon (top right), then start pairing for this player in
Music Assistant. The PIN appears in the Settings drawer automatically — the drawer opens by itself when
a PIN arrives. If Music Assistant asks for a confirmation on the device, press **Allow pairing**.

Clearing the TV browser's data removes the pairing; pair again the same way.

## Updating

Rebuild and restart the container:

```bash
docker compose up -d --build
```

If changes don't show up, Docker may be reusing cached build steps:

```bash
docker compose build --no-cache && docker compose up -d
```

Every build gets a build ID, which is added to the script URL so the TV never combines a new page
with an old cached script. The ID is shown at the top of the Settings debug log
(`VIDAA Sendspin UI ready, build …`) — check it first if the TV seems to run an older version.

## How it works

The container runs a small Node server (`server/index.mjs`) that serves the UI and provides two
endpoints:

| Endpoint | Purpose |
|---|---|
| `GET /api/server` | The Sendspin server found via mDNS (`_sendspin-server._tcp`). Browsers cannot use mDNS themselves, so the TV asks here and then connects directly to the advertised address. |
| `GET /api/art?url=…` | Re-serves artwork from the app's own address so the UI may read its pixels for the colours (artwork hosts usually don't allow that cross-origin). Only http(s) URLs that return an image are passed through. |

If `/api/server` is unavailable (e.g. `dist/` hosted by a plain web server), the UI tries
`ws://<page host>:8927/sendspin`, which works when the UI is hosted on the Music Assistant machine.
Artwork colours then fall back to the neutral palette.

## Remote control

| Key | Action |
|---|---|
| Any key while the controls are hidden | Show the controls again (the key itself is not acted on) |
| Arrow keys | Move between controls |
| OK | Activate the focused control |
| Left / Right on the progress bar | Seek 10 s back / forward; presses add up and the seek is sent when you pause, press OK or leave the bar |
| OK on the volume slider | Start adjusting: Left / Right change the volume; OK, Back, Up or Down stop |
| Up / Down on the debug log | Scroll the log |
| Back | Stop volume adjustment, close Settings, or — on the Now Playing screen — close the app |

Focus moves by on-screen position. While Settings is open, focus stays inside the drawer.

## Development

Requires Node.js 22 (as used in the Docker image).

```bash
npm install
npm run serve        # builds dist/ and starts the server on :8080
```

`npm run build` only builds `dist/`; `npm start` only starts the server.

```text
.
├── Dockerfile
├── docker-compose.yaml
├── build.mjs        # bundles src/main.js, copies public/ and the Inter fonts, adds the build ID
├── package.json
├── public/          # index.html, app icons, manifest
├── server/          # static server, mDNS discovery and artwork proxy
└── src/main.js      # UI logic, bundled to dist/sendspin.js
```

## VIDAA notes

- The app is bundled as a single IIFE with an ES2017 target and needs no native ES module support.
  WebSocket, Web Audio and WebCrypto must still be provided by the TV's browser.
- Audio starts on launch. If a TV browser blocks that, any remote key press starts it.
- Remote keys are captured on `window` in the capture phase, because some VIDAA shells consume them
  earlier. Navigation keys are 37/38/39/40, OK is 13 and Back is 8.
- Focus uses plain `element.focus()` for compatibility with older VIDAA browser engines.
- Remote keys the app does not handle are written to the debug log, e.g.
  `Unhandled key key=ColorF0Red code=403`.
