// Minimal zero-dependency WebSocket server (RFC 6455: text frames, ping/pong, close, fragmentation).
// Used automatically when the "ws" package is not installed, so the server runs with plain Node 16+.
const crypto = require('crypto');
const { EventEmitter } = require('events');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class Socket extends EventEmitter {
  constructor(sock) {
    super(); this.sock = sock; this.buf = Buffer.alloc(0); this.readyState = 1; this.frag = null;
    sock.on('data', d => { this.buf = Buffer.concat([this.buf, d]); try { this._parse(); } catch (e) { this.terminate(); } });
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
