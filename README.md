# Meccha Camouflage – multiplayer server

Zero-dependency Node.js server (uses the `ws` package automatically if you install it, otherwise its own tiny WebSocket implementation).

## Run locally
```
node server.js            # listens on :8080  (PORT env var to change)
```
Open `macha2.0.html` from a local file or localhost – it connects to `ws://localhost:8080` by itself.
To test with another URL: `macha2.0.html?server=ws://192.168.1.5:8080`

## Deploy (needed for CrazyGames / real players)
Any host that runs Node 16+ works (Render, Railway, Fly.io, a VPS...). Example on Render: New -> Web Service -> connect the repo/folder ->
Build command: (empty) - Start command: `node server.js` - it gives you `https://your-app.onrender.com`.
Your game page is served over https, so the game must use **wss://**:

1. In `macha2.0.html` set `window.MACHA_SERVER = 'wss://your-app.onrender.com';` (top of the file, search for `MACHA_SERVER`).
2. Optional hardening: set env `ALLOWED_ORIGINS` to a comma list of the sites that may connect (e.g. `https://www.crazygames.com`).
3. Check `https://your-app.onrender.com/health` -> `{"ok":true,...}`.

Free hosting tiers sleep when idle - the first connection can take ~30 s. Use an always-on instance for a real launch.

## How it works
* Rooms with a 4-letter code; public rooms show up in *Find Server*; password rooms supported; *PLAY GAME* = quick-match.
* The host controls the settings (mode, hunters, timers, map, filters); the server runs the whole match: roles -> selecting -> hide -> search -> answer -> result -> lobby.
* The server decides catches (hunter `shoot` -> hider caught; Infection mode turns the hider into a hunter), scores and winners.
* Positions are relayed at ~15-20 Hz, painted body colours as 8x8 textures per body part, chat, taunts, forced taunts.
* Basic protection: per-socket rate limit, message size limit, name sanitising, optional origin allow-list.
* Needs **2+ players** to start an online match (solo play uses the offline mode with bots).
* If you add a map to the game, add its name to `MAP_NAMES` in `server.js` too.
