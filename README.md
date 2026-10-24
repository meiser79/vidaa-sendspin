# VIDAA Sendspin

A browser-based Sendspin player for VIDAA TVs using [`sendspin/sendspin-js`](https://github.com/Sendspin/sendspin-js).

The client connects directly to a Sendspin server over WebSocket and provides a TV-friendly interface for synchronized playback, pairing by PIN, playback controls, volume control, metadata, artwork, connection status, and diagnostics.

## Features

- Single full-screen Now Playing view: artwork, title, artist, album, year, stream-quality badges, live progress
- Transport controls (shuffle / previous / play-pause / next / repeat) and volume, reflecting server state
- Automatic discovery of the Music Assistant Sendspin server via mDNS (`_sendspin-server._tcp`) — nothing to configure
- Automatic reconnect, falling back to rediscovery if the server moves
- Settings drawer (gear icon, top right) for dynamic-PIN pairing, connection info and a debug log
- D-pad / remote-control navigation, VIDAA media keys
- PWA manifest and favicon

## Server discovery

Browsers cannot browse mDNS, so the container runs a small Node server (`server/index.mjs`) that
serves the UI and continuously browses for `_sendspin-server._tcp`. The TV asks it via
`GET /api/server` and connects directly to the advertised address.

mDNS multicast does not cross Docker's bridge network, so the container must use **host networking**
(see `docker-compose.yaml`).

If the discovery endpoint is unavailable (e.g. the `dist/` folder is hosted by a plain web server),
the UI tries `ws://<page host>:8927/sendspin`, which works when the UI is hosted on the Music Assistant machine.

## Build and run locally

```bash
npm install
npm run serve        # builds dist/ and starts the server on :8080
```

Then open `http://YOUR-SERVER-IP:8080/` on the VIDAA TV.

## Docker

```bash
docker compose up -d --build
```

## Pairing

Pairing is only needed once. Press the gear icon (top right), then start pairing for this player in
Music Assistant. The PIN appears in the drawer automatically (the drawer also opens by itself when a
PIN arrives). If Music Assistant asks for a local confirmation, press **Allow pairing**.

## VIDAA notes

The application is bundled as a single browser-compatible IIFE and does not require native ES module support.

The JavaScript build target is ES2017. Missing native browser APIs such as WebSocket, Web Audio, or WebCrypto still depend on the VIDAA browser implementation.

Audio initialization is performed from the player startup flow because TV browsers may enforce autoplay restrictions.

## Project structure

```text
.
├── Dockerfile
├── docker-compose.yaml
├── build.mjs
├── package.json
├── public/          # index.html, favicon, manifest
├── server/          # static server + mDNS discovery endpoint
└── src/main.js      # UI logic, bundled to dist/sendspin.js
```

## Remote control navigation

The interface is designed to work without a mouse cursor.

Supported controls:

- Arrow Up / Down / Left / Right: move focus between visible controls
- OK / Enter: activate the focused control
- Back: close Settings; from Now Playing the app asks the browser to close
- Focused controls are highlighted with a blue focus ring

The navigation algorithm uses the on-screen position of controls, so it works across the playback controls and the Settings drawer.

### Remote troubleshooting

Remote events are captured on `window` during the capture phase for VIDAA compatibility.
Remote keys the app does not handle are written to the Debug log as:

```text
Unhandled key key=ColorF0Red code=403
```

VIDAA mandatory navigation key codes are 37/38/39/40, OK is 13 and Back is 8.
The implementation deliberately uses legacy `element.focus()` for compatibility with older VIDAA browser engines.
