// Meccha Camouflage multiplayer server.  Zero dependencies: uses the "ws" package when installed, else ./miniws.js
//   node server.js            (PORT env var, default 8080)
// Deploy anywhere that runs Node 16+ (Render, Railway, Fly.io, a VPS ...). Put it behind HTTPS so the game can use wss://
const http = require('http');
let WebSocketServer;
const __miniws = (function(){ const module = { exports: {} };
// Minimal zero-dependency WebSocket server (RFC 6455: text frames, ping/pong, close, fragmentation).
// Used automatically when the "ws" package is not installed, so the server runs with plain Node 16+.
const crypto = require('crypto');
const { EventEmitter } = require('events');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class Socket extends EventEmitter {
  constructor(sock) {
    super(); this.sock = sock; this.buf = Buffer.alloc(0); this.readyState = 1; this.frag = null;
    sock.on('data', d => { this.buf = Buffer.concat([this.buf, d]); try { this._parse(); } catch (e) { this.terminate(); } });
    sock.on('end', () => { try { sock.destroy(); } catch (e) {} });   // http servers keep half-open sockets: treat FIN as a real disconnect
    sock.on('close', () => { if (this.readyState !== 3) { this.readyState = 3; this.emit('close'); } });
    sock.on('error', () => { try { sock.destroy(); } catch (e) {} });
    sock.setNoDelay(true);
  }
  _parse() {
    for (;;) {
      const b = this.buf; if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0; let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (len > 1 << 20) throw new Error('frame too large');
      if (!masked) throw new Error('unmasked frame');
      if (b.length < off + 4 + len) return;
      const mask = b.slice(off, off + 4); const data = Buffer.from(b.slice(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      this.buf = b.slice(off + 4 + len);
      if (op === 0x8) { this.close(); return; }
      if (op === 0x9) { this._frame(0xA, data); continue; }
      if (op === 0xA) continue;
      if (op === 0x1 || op === 0x2) { this.frag = { op, parts: [data] }; } else if (op === 0x0 && this.frag) { this.frag.parts.push(data); }
      if (fin && this.frag) { const all = Buffer.concat(this.frag.parts); const isText = this.frag.op === 0x1; this.frag = null; this.emit('message', isText ? all.toString('utf8') : all); }
    }
  }
  _frame(op, payload) {
    if (this.readyState !== 1) return;
    const len = payload.length; let head;
    if (len < 126) head = Buffer.from([0x80 | op, len]);
    else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
    try { this.sock.write(Buffer.concat([head, payload])); } catch (e) {}
  }
  send(str) { this._frame(0x1, Buffer.from(String(str), 'utf8')); }
  ping() { this._frame(0x9, Buffer.alloc(0)); }
  close() { if (this.readyState === 1) { this._frame(0x8, Buffer.alloc(0)); this.readyState = 2; try { this.sock.end(); } catch (e) {} } }
  terminate() { this.readyState = 3; try { this.sock.destroy(); } catch (e) {} this.emit('close'); }
}

class Server extends EventEmitter {
  constructor({ server }) {
    super(); this.clients = new Set();
    server.on('upgrade', (req, sock) => {
      const key = req.headers['sec-websocket-key'];
      if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { sock.destroy(); return; }
      const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
      sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
      const ws = new Socket(sock); this.clients.add(ws); ws.on('close', () => this.clients.delete(ws));
      ws.req = req; this.emit('connection', ws, req);
    });
  }
}
module.exports = { WebSocketServer: Server };

return module.exports; })();
try { WebSocketServer = require('ws').WebSocketServer; } catch (e) { WebSocketServer = __miniws.WebSocketServer; }

const PORT = +process.env.PORT || 8080;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean); // e.g. https://www.crazygames.com,https://your-game.crazygames.com
// keep in sync with MAPS in the game file
const MAP_NAMES = ['Hide-and-Seek Mansion', 'Sewer', 'Backrooms', 'Indoor Country', 'Penguin Hotel', 'Osaka', 'Sugar Land', 'City', 'Minecraft', 'Museum'];
const DEFAULTS = { mode: 'Basic', hunters: 1, hunterWait: 60, searchTime: 180, answerTime: 15, taunt: 40, showRank: true, map: 'Random', filters: { Monochrome: false, Horror: false, Mosaic: false } };
const RESULT_TIME = 12, SELECT_TIME = 5, MAX_ROOMS = 500, MAX_PLAYERS = 24;

const gHist = [];                     // last global chat lines
const rooms = new Map();
const clients = new Map();            // id -> player
let nextId = 1;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const num = (v, d) => (typeof v === 'number' && isFinite(v)) ? v : d;
const clean = (s, n) => String(s == null ? '' : s).replace(/[<>&"'`]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() { let c; do { c = ''; for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]; } while (rooms.has(c)); return c; }

function send(p, msg) { if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(msg)); }
function bcast(room, msg, except) { const s = JSON.stringify(msg); room.players.forEach(p => { if (p !== except && p.ws.readyState === 1) p.ws.send(s); }); }
function pubPlayers(room) { return [...room.players.values()].map(p => ({ id: p.id, name: p.name, host: p.id === room.hostId, role: p.role })); }
function counts(room) { let h = 0, u = 0; room.players.forEach(p => { if (!room.inMatch.has(p.id)) return; if (p.role === 'hunter') u++; else if (p.alive) h++; }); return { hiders: h, hunters: u }; }

function sanitizeSettings(s, base) {
  const o = Object.assign({}, base || DEFAULTS); if (!s || typeof s !== 'object') return o;
  if (s.mode === 'Basic' || s.mode === 'Infection') o.mode = s.mode;
  if ('hunters' in s) o.hunters = clamp(Math.round(num(s.hunters, o.hunters)), 1, 3);
  if ('hunterWait' in s) o.hunterWait = clamp(Math.round(num(s.hunterWait, o.hunterWait)), 10, 900);
  if ('searchTime' in s) o.searchTime = clamp(Math.round(num(s.searchTime, o.searchTime)), 30, 900);
  if ('answerTime' in s) o.answerTime = clamp(Math.round(num(s.answerTime, o.answerTime)), 5, 120);
  if ('taunt' in s) o.taunt = clamp(Math.round(num(s.taunt, o.taunt)), 0, 120);
  if ('showRank' in s) o.showRank = !!s.showRank;
  if (s.map === 'Random' || MAP_NAMES.includes(s.map)) o.map = s.map;
  if (s.filters && typeof s.filters === 'object') { o.filters = Object.assign({}, o.filters); ['Monochrome', 'Horror', 'Mosaic'].forEach(k => { if (k in s.filters) o.filters[k] = !!s.filters[k]; }); }
  return o;
}

function createRoom(host, opt) {
  if (rooms.size >= MAX_ROOMS) { send(host, { t: 'error', msg: 'Server is full, try again later' }); return null; }
  const code = newCode();
  const room = { code, name: clean(opt.server || opt.name, 24) || 'Macha Server', pass: clean(opt.pass, 12), priv: !!clean(opt.pass, 12), max: clamp(Math.round(num(opt.max, 12)), 2, MAX_PLAYERS), region: clean(opt.region, 20) || 'Not Specified', tags: Array.isArray(opt.tags) ? opt.tags.slice(0, 6).map(t => clean(t, 30)) : [],
    hostId: host.id, players: new Map(), settings: sanitizeSettings(opt.settings), phase: 'lobby', t: 0, inMatch: new Set(), searchLen: 0, nextTaunt: 0, createdAt: Date.now(), quick: !!opt.quick };
  rooms.set(code, room); addToRoom(room, host); return room;
}
function addToRoom(room, p) {
  if (p.room) removeFromRoom(p, true);
  p.room = room; room.players.set(p.id, p); p.role = 'hider'; p.alive = true; p.stats = { found: 0, miss: 0 }; p.st = null; p.look = null;
  send(p, { t: 'joined', code: room.code, you: p.id, host: room.hostId, name: room.name, max: room.max, priv: room.priv, settings: room.settings, phase: room.phase, players: pubPlayers(room), looks: [...room.players.values()].filter(q => q.look && q !== p).map(q => ({ id: q.id, parts: q.look })) });
  bcast(room, { t: 'pjoin', id: p.id, name: p.name, players: pubPlayers(room) }, p);
}
function removeFromRoom(p, silent) {
  const room = p.room; if (!room) return; room.players.delete(p.id); room.inMatch.delete(p.id); p.room = null;
  if (!room.players.size) { rooms.delete(room.code); return; }
  if (room.hostId === p.id) room.hostId = room.players.keys().next().value;
  if (!silent) bcast(room, { t: 'pleave', id: p.id, name: p.name, host: room.hostId, players: pubPlayers(room), counts: counts(room) });
  if (room.phase === 'search' || room.phase === 'hide' || room.phase === 'selecting') checkEnd(room);
}

// ---------------- match state machine ----------------
function setPhase(room, phase, t, extra) {
  room.phase = phase; room.t = t;
  bcast(room, Object.assign({ t: 'phase', phase, left: Math.ceil(t), counts: counts(room) }, extra || {}));
}
function startMatch(room) {
  if (room.phase !== 'lobby') return;
  const list = [...room.players.values()];
  if (list.length < 2) { const h = room.players.get(room.hostId); if (h) send(h, { t: 'error', msg: 'You need at least 2 players to start an online match' }); return; }
  const S = room.settings;
  const map = (S.map === 'Random' || !MAP_NAMES.includes(S.map)) ? MAP_NAMES[Math.floor(Math.random() * MAP_NAMES.length)] : S.map;
  const nh = clamp(S.hunters, 1, Math.min(3, list.length - 1));
  const app = shuffle(list.filter(p => p.applicant)), rest = shuffle(list.filter(p => !p.applicant));
  const hunters = app.concat(rest).slice(0, nh).map(p => p.id);
  room.inMatch = new Set(list.map(p => p.id)); room.searchLen = S.searchTime; room.nextTaunt = S.taunt;
  const roles = {};
  list.forEach(p => { p.role = hunters.includes(p.id) ? 'hunter' : 'hider'; p.alive = true; p.infected = false; p.stats = { found: 0, miss: 0 }; p.caughtAt = 0; p.lastShoot = 0; roles[p.id] = p.role; });
  room.map = map; room.roles = roles;
  setPhase(room, 'selecting', SELECT_TIME, { map, roles, settings: S, names: Object.fromEntries(list.map(p => [p.id, p.name])) });
}
function points(room, p, winner) {
  const win = winner === (p.role === 'hunter' ? 'hunters' : 'hiders');
  if (p.role === 'hunter' && !p.infected) return p.stats.found * 100 - p.stats.miss * 37 + (win ? 200 : 0);
  const surv = p.alive ? room.searchLen : Math.round(p.caughtAt || 0);
  return (p.alive ? 300 : 0) + surv * 5 + (win && !p.infected ? 200 : 0) + (p.infected ? p.stats.found * 100 : 0);
}
function endMatch(room, winner) {
  if (room.phase === 'result' || room.phase === 'lobby') return;
  const rows = [...room.players.values()].filter(p => room.inMatch.has(p.id)).map(p => ({ id: p.id, name: p.name, role: p.infected ? 'Infected' : (p.role === 'hunter' ? 'Hunter' : 'Hider'), found: p.stats.found, miss: p.stats.miss, time: p.alive ? Math.round(room.searchLen) : Math.round(p.caughtAt || 0), alive: p.alive, pts: points(room, p, winner) })).sort((a, b) => b.pts - a.pts);
  setPhase(room, 'result', RESULT_TIME, { winner, rows });
}
function checkEnd(room) {
  const c = counts(room);
  if (room.phase === 'search' && c.hiders <= 0) endMatch(room, 'hunters');
  else if ((room.phase === 'search' || room.phase === 'hide' || room.phase === 'selecting') && c.hunters <= 0) endMatch(room, 'hiders');
  else if ((room.phase === 'search' || room.phase === 'hide' || room.phase === 'selecting') && c.hiders <= 0 && c.hunters > 0 && room.phase !== 'search') endMatch(room, 'hunters');
}
function tickRoom(room, dt) {
  if (room.phase === 'lobby') return;
  room.t -= dt;
  if (room.phase === 'search' && room.settings.taunt > 0) {
    room.nextTaunt -= dt;
    if (room.nextTaunt <= 0) { room.nextTaunt = room.settings.taunt; const al = [...room.players.values()].filter(p => p.role === 'hider' && p.alive && room.inMatch.has(p.id)); if (al.length) bcast(room, { t: 'taunt', id: al[Math.floor(Math.random() * al.length)].id, forced: true }); }
  }
  room.tickAcc = (room.tickAcc || 0) + dt;
  if (room.tickAcc >= 1) { room.tickAcc = 0; bcast(room, { t: 'tick', phase: room.phase, left: Math.max(0, Math.ceil(room.t)), counts: counts(room) }); }
  if (room.t > 0) return;
  const S = room.settings;
  if (room.phase === 'selecting') setPhase(room, 'hide', S.hunterWait);
  else if (room.phase === 'hide') setPhase(room, 'search', S.searchTime);
  else if (room.phase === 'search') setPhase(room, 'answer', S.answerTime);
  else if (room.phase === 'answer') endMatch(room, counts(room).hiders > 0 ? 'hiders' : 'hunters');
  else if (room.phase === 'result') {
    room.players.forEach(p => { p.role = 'hider'; p.alive = true; p.infected = false; p.applicant = false; });
    room.inMatch = new Set(); setPhase(room, 'lobby', 0, { players: pubPlayers(room), settings: room.settings });
  }
}
function doShoot(p, m) {
  const room = p.room; if (!room || room.phase !== 'search' || p.role !== 'hunter' || !room.inMatch.has(p.id)) return;
  const now = Date.now(); if (now - p.lastShoot < 280) return; p.lastShoot = now;
  const T = m.target && room.players.get(String(m.target));
  const pt = Array.isArray(m.p) ? m.p.slice(0, 3).map(v => Math.round(num(v, 0) * 100) / 100) : null;
  if (T && T !== p && T.role === 'hider' && T.alive && room.inMatch.has(T.id) && p.st && T.st && Math.hypot(p.st.x - T.st.x, p.st.z - T.st.z) < 90) {
    p.stats.found++; T.caughtAt = Math.max(0, room.searchLen - room.t);
    if (room.settings.mode === 'Infection') { T.role = 'hunter'; T.infected = true; T.alive = true; } else T.alive = false;
    bcast(room, { t: 'caught', id: T.id, by: p.id, byName: p.name, name: T.name, infected: !!T.infected, p: pt, counts: counts(room) });
    checkEnd(room);
  } else { p.stats.miss++; bcast(room, { t: 'shot', id: p.id, p: pt, miss: p.stats.miss }, p); send(p, { t: 'miss', miss: p.stats.miss }); }
}

// ---------------- connection handling ----------------
const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, rooms: rooms.size, players: clients.size, uptime: Math.round(process.uptime()) })); return; }
  res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('Meccha Camouflage server is running\n');
});
const wss = new WebSocketServer({ server: httpServer });
wss.on('connection', (ws, req) => {
  const origin = req && req.headers && req.headers.origin;
  if (ALLOWED_ORIGINS.length && origin && !ALLOWED_ORIGINS.some(o => origin === o || origin.endsWith(o.replace(/^https?:\/\//, '.')))) { ws.close(); return; }
  const p = { id: 'p' + (nextId++).toString(36), ws, name: 'Player', room: null, role: 'hider', alive: true, applicant: false, bucket: 120, bt: Date.now(), st: null, look: null, stats: { found: 0, miss: 0 }, lastShoot: 0 };
  clients.set(p.id, p); send(p, { t: 'welcome', id: p.id, maps: MAP_NAMES });
  const hb = setInterval(() => { if (ws.ping) try { ws.ping(); } catch (e) {} }, 25000);
  ws.on('message', raw => {
    const now = Date.now(); p.bucket = Math.min(160, p.bucket + (now - p.bt) / 1000 * 100); p.bt = now; if (--p.bucket < 0) return;
    if (typeof raw !== 'string') raw = raw.toString();
    if (raw.length > 8192) return; let m; try { m = JSON.parse(raw); } catch (e) { return; } if (!m || typeof m.t !== 'string') return;
    handle(p, m);
    if (p.uid && (m.t === 'create' || m.t === 'join' || m.t === 'quick' || m.t === 'leave')) notifyFriends(p, { t: 'fpres', p: presence(p) });
  });
  ws.on('close', () => { clearInterval(hb); clients.delete(p.id); removeFromRoom(p); if (p.uid && byUid.get(p.uid) === p) { byUid.delete(p.uid); notifyFriends(p, { t: 'fpres', p: { uid: p.uid, name: p.name, online: false, room: '' } }); } });
  ws.on('error', () => {});
});

// ---------------- friends / presence / DMs (stateless: friend lists live in the players' browsers) ----------------
const byUid = new Map();       // uid -> online player
const owners = new Map();      // uid -> secret key (first claim wins, in memory)
const pendingReq = new Map();  // uid -> [{ t:'freq'|'facc'|'frem', from, name, ts }]  delivered when that player comes online
const UID_RE = /^[A-Z0-9]{6,12}$/;
const uidOf = s => { s = String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); return UID_RE.test(s) ? s : ''; };
function queueFor(uid, item) { const a = pendingReq.get(uid) || []; if (a.length >= 30) a.shift(); a.push(item); pendingReq.set(uid, a); }
function presence(q) { return { uid: q.uid, name: q.name, online: true, room: q.room ? q.room.code : '' }; }
function notifyFriends(p, msg) { byUid.forEach(q => { if (q !== p && q.friends && q.friends.has(p.uid)) send(q, msg); }); }
function isFriendPair(a, b) { return a.friends && b.friends && a.friends.has(b.uid) && b.friends.has(a.uid); }
function social(p, m) {
  switch (m.t) {
    case 'fhello': {
      const uid = uidOf(m.uid), key = String(m.key || '').slice(0, 64);
      if (!uid || key.length < 8) { send(p, { t: 'ferr', code: 'bad', msg: 'Bad friend id' }); return; }
      if (owners.has(uid) && owners.get(uid) !== key) { send(p, { t: 'fclash' }); return; }
      owners.set(uid, key);
      if (p.uid && p.uid !== uid && byUid.get(p.uid) === p) byUid.delete(p.uid);
      const old = byUid.get(uid); if (old && old !== p) { old.uid = ''; send(old, { t: 'fkick' }); }
      p.uid = uid; byUid.set(uid, p); p.name = clean(m.name, 20) || p.name;
      p.friends = new Set((Array.isArray(m.friends) ? m.friends : []).slice(0, 200).map(uidOf).filter(Boolean));
      const on = []; p.friends.forEach(f => { const q = byUid.get(f); if (q) on.push(presence(q)); });
      send(p, { t: 'fstatus', online: on });
      const q = pendingReq.get(uid); if (q) { pendingReq.delete(uid); q.forEach(it => send(p, it)); }
      notifyFriends(p, { t: 'fpres', p: presence(p) });
      return;
    }
    case 'fsync': { if (!p.uid) return; p.friends = new Set((Array.isArray(m.friends) ? m.friends : []).slice(0, 200).map(uidOf).filter(Boolean));
      const on = []; p.friends.forEach(f => { const q = byUid.get(f); if (q) on.push(presence(q)); }); send(p, { t: 'fstatus', online: on }); return; }
    case 'freq': {
      if (!p.uid) return; const to = uidOf(m.to);
      if (!to || to === p.uid) { send(p, { t: 'fack', to: to, ok: false, msg: to === p.uid ? "That's your own code" : 'Invalid friend code' }); return; }
      if (!owners.has(to) && !byUid.has(to)) { send(p, { t: 'fack', to: to, ok: false, msg: 'No player with that code (they must open the game once)' }); return; }
      const item = { t: 'freq', from: p.uid, name: p.name, ts: Date.now() }, q = byUid.get(to);
      if (q) send(q, item); else queueFor(to, item);
      send(p, { t: 'fack', to: to, ok: true, queued: !q }); return;
    }
    case 'facc': {
      if (!p.uid) return; const to = uidOf(m.to); if (!to) return;
      if (p.friends) p.friends.add(to);
      const item = { t: 'facc', from: p.uid, name: p.name, ts: Date.now() }, q = byUid.get(to);
      if (q) { if (q.friends) q.friends.add(p.uid); send(q, item); send(q, { t: 'fpres', p: presence(p) }); } else queueFor(to, item);
      if (q) send(p, { t: 'fpres', p: presence(q) }); return;
    }
    case 'frem': {
      if (!p.uid) return; const to = uidOf(m.to); if (!to) return;
      if (p.friends) p.friends.delete(to);
      const q = byUid.get(to), item = { t: 'frem', from: p.uid, ts: Date.now() };
      if (q) { if (q.friends) q.friends.delete(p.uid); send(q, item); } else queueFor(to, item); return;
    }
    case 'dm': {
      if (!p.uid) return; const to = uidOf(m.to), txt = clean(m.text, 200); if (!to || !txt) return;
      const now = Date.now(); if (now - (p.lastDm || 0) < 500) return; p.lastDm = now;
      const q = byUid.get(to);
      if (!q || !isFriendPair(p, q)) { send(p, { t: 'dmfail', to: to, msg: q ? 'You are not friends yet' : 'Friend is offline' }); return; }
      send(q, { t: 'dm', from: p.uid, name: p.name, text: txt, ts: now }); return;
    }
    case 'finv': {
      if (!p.uid || !p.room) return; const to = uidOf(m.to), q = byUid.get(to);
      if (!q || !isFriendPair(p, q)) { send(p, { t: 'dmfail', to: to, msg: 'Friend is offline' }); return; }
      send(q, { t: 'finv', from: p.uid, name: p.name, code: p.room.code, room: p.room.name, priv: !!p.room.pass }); return;
    }
  }
}
function findRoom(code) { return rooms.get(String(code || '').toUpperCase().trim()); }
function handle(p, m) {
  if (m.t.charCodeAt(0) === 102 || m.t === 'dm') { social(p, m); return; }   // f* (friends) and dm
  switch (m.t) {
    case 'hello': p.name = clean(m.name, 20) || p.name; break;
    case 'list': send(p, { t: 'rooms', rooms: [...rooms.values()].filter(r => r.players.size < r.max).map(r => ({ code: r.code, name: r.name, players: r.players.size, max: r.max, priv: r.priv, region: r.region, tags: r.tags, phase: r.phase })).slice(0, 100) }); break;
    case 'create': p.name = clean(m.name, 20) || p.name; createRoom(p, m); break;
    case 'join': {
      p.name = clean(m.name, 20) || p.name; const r = findRoom(m.code);
      if (!r) return send(p, { t: 'error', msg: 'Room not found' });
      if (r.players.size >= r.max) return send(p, { t: 'error', msg: 'Room is full' });
      if (r.priv && r.pass !== clean(m.pass, 12)) return send(p, { t: 'error', msg: 'Wrong password', need: 'pass', code: r.code });
      addToRoom(r, p); break;
    }
    case 'quick': {
      p.name = clean(m.name, 20) || p.name;
      let best = null; rooms.forEach(r => { if (!r.priv && r.phase === 'lobby' && r.players.size < r.max && (!best || r.players.size > best.players.size)) best = r; });
      if (best) addToRoom(best, p); else createRoom(p, { server: 'Quick Match', max: 12, quick: true, settings: m.settings });
      break;
    }
    case 'name': p.name = clean(m.name, 20) || p.name; if (p.room) bcast(p.room, { t: 'pname', id: p.id, name: p.name, players: pubPlayers(p.room) }); break;
    case 'settings': { const r = p.room; if (r && r.hostId === p.id && r.phase === 'lobby') { r.settings = sanitizeSettings(m.settings, r.settings); bcast(r, { t: 'settings', settings: r.settings }); } break; }
    case 'applicant': p.applicant = !!m.on; break;
    case 'start': { const r = p.room; if (r && r.hostId === p.id) startMatch(r); break; }
    case 'state': {
      const r = p.room; if (!r) return;
      p.st = { x: num(m.x, 0), y: num(m.y, 0), z: num(m.z, 0), r: num(m.r, 0), j: typeof m.j === 'string' ? m.j.slice(0, 220) : '', f: m.f | 0 };
      p.dirty = true; break;
    }
    case 'look': { const r = p.room; if (!r || !Array.isArray(m.parts) || m.parts.length > 12) return; p.look = m.parts.map(s => String(s).slice(0, 400)); bcast(r, { t: 'look', id: p.id, parts: p.look }, p); break; }
    case 'shoot': doShoot(p, m); break;
    case 'taunt': if (p.room) bcast(p.room, { t: 'taunt', id: p.id }, p); break;
    case 'chat': { const txt = clean(m.text, 120); const nowc = Date.now(); if (nowc - (p.lastChat || 0) < 600) break; p.lastChat = nowc; if (p.room && txt) bcast(p.room, { t: 'chat', id: p.id, name: p.name, text: txt }); break; }
    case 'leave': removeFromRoom(p); send(p, { t: 'left' }); break;
    case 'gchat': { const txt = clean(m.text, 140); const nw = Date.now(); if (!txt || nw - (p.lastG || 0) < 1500) break; p.lastG = nw;
      const it = { t: 'gchat', name: p.name, uid: p.uid || '', text: txt, ts: nw }; gHist.push(it); if (gHist.length > 40) gHist.shift(); clients.forEach(q => send(q, it)); break; }
    case 'ghist': send(p, { t: 'ghist', items: gHist.slice(-30) }); break;
    case 'ping': send(p, { t: 'pong', c: m.c }); break;
  }
}
// 20 Hz world tick: phase timers + position snapshots
let last = Date.now();
setInterval(() => {
  const now = Date.now(), dt = (now - last) / 1000 * (+process.env.TIME_SCALE || 1); last = now;
  rooms.forEach(room => {
    tickRoom(room, dt);
    const arr = []; room.players.forEach(q => { if (q.dirty && q.st) { q.dirty = false; arr.push([q.id, q.st.x, q.st.y, q.st.z, q.st.r, q.st.j, q.st.f]); } });
    if (arr.length) bcast(room, { t: 'snap', p: arr });
  });
}, 50);
httpServer.listen(PORT, () => console.log('Meccha server listening on :' + PORT + (WebSocketServer === undefined ? '' : '')));
module.exports = { httpServer, rooms };
