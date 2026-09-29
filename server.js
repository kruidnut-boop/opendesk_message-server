/*
 * OpenDesk Messaging Server
 * ---------------------------------------------------------------
 * A tiny, dependency-free real-time chat relay for OpenDesk's
 * Messages app. Uses only Node's built-in modules (http, crypto,
 * fs) — there's nothing to `npm install`.
 *
 * This is a small demo-grade server, not a production messaging
 * platform: passwords are hashed but not salted, there's no rate
 * limiting or spam protection, and data is stored in a plain JSON
 * file on disk. It's fine for personal or small-group use.
 * ---------------------------------------------------------------
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const MSGS_FILE = path.join(DATA_DIR, 'messages.json');

function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function saveJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data)); } catch (e) { console.error('save failed', e.message); }
}
let users = loadJSON(USERS_FILE, {});       // { id: { pass: sha256hash, name } }
let messages = loadJSON(MSGS_FILE, {});     // { id: [ {from,to,text,ts,delivered} ] }  (recipient's inbox)
function saveUsers() { saveJSON(USERS_FILE, users); }
function saveMessages() { saveJSON(MSGS_FILE, messages); }
function hash(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

/* ---------- minimal RFC6455 WebSocket framing (text frames only) ---------- */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[0] = 0x81; header[1] = len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([header, payload]);
}
function decodeFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const b0 = buffer[offset], b1 = buffer[offset + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f, idx = offset + 2;
    if (len === 126) { if (buffer.length - idx < 2) break; len = buffer.readUInt16BE(idx); idx += 2; }
    else if (len === 127) { if (buffer.length - idx < 8) break; len = Number(buffer.readBigUInt64BE(idx)); idx += 8; }
    let maskKey;
    if (masked) { if (buffer.length - idx < 4) break; maskKey = buffer.slice(idx, idx + 4); idx += 4; }
    if (buffer.length - idx < len) break;
    let payload = buffer.slice(idx, idx + len);
    if (masked) { const u = Buffer.alloc(len); for (let i = 0; i < len; i++) u[i] = payload[i] ^ maskKey[i % 4]; payload = u; }
    frames.push({ opcode, payload });
    offset = idx + len;
  }
  return { frames, offset };
}

/* ---------- HTTP + upgrade ---------- */
const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OpenDesk messaging server is running.\n');
});

const clients = new Map(); // id -> socket

httpServer.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');

  let buffer = Buffer.alloc(0);
  let myId = null;

  function send(obj) { try { socket.write(encodeFrame(JSON.stringify(obj))); } catch (e) {} }

  function handleMessage(msg) {
    if (msg.type === 'hello') {
      const id = String(msg.id || '').toLowerCase().replace(/[^a-z0-9_.]/g, '');
      const name = String(msg.name || id).slice(0, 40);
      const pass = String(msg.pass || '');
      if (!id || pass.length < 4) { send({ type: 'hello-err', reason: 'Invalid ID or password.' }); return; }
      if (!users[id]) { users[id] = { pass: hash(pass), name }; saveUsers(); }
      else if (users[id].pass !== hash(pass)) { send({ type: 'hello-err', reason: 'That OpenDesk ID is already taken by someone else on this server.' }); return; }
      else { users[id].name = name; saveUsers(); }
      myId = id;
      clients.set(id, socket);
      const backlog = (messages[id] || []).filter(m => !m.delivered);
      backlog.forEach(m => m.delivered = true);
      saveMessages();
      send({ type: 'hello-ok', id, name: users[id].name, backlog });
      return;
    }
    if (!myId) return; // must authenticate first
    if (msg.type === 'lookup') {
      const id = String(msg.id || '').toLowerCase();
      send({ type: 'lookup-result', id, exists: !!users[id], name: users[id] ? users[id].name : null });
      return;
    }
    if (msg.type === 'msg') {
      const to = String(msg.to || '').toLowerCase();
      const text = String(msg.text || '').slice(0, 2000);
      if (!to || !text || !users[to]) { send({ type: 'msg-err', reason: 'Unknown recipient.' }); return; }
      const packet = { from: myId, to, text, ts: Date.now() };
      const recSock = clients.get(to);
      if (recSock && !recSock.destroyed) {
        packet.delivered = true;
        try { recSock.write(encodeFrame(JSON.stringify({ type: 'msg', from: myId, fromName: users[myId].name, text, ts: packet.ts }))); }
        catch (e) { packet.delivered = false; }
      } else packet.delivered = false;
      messages[to] = messages[to] || [];
      messages[to].push(packet);
      saveMessages();
      send({ type: 'msg-ack', to, ts: packet.ts, delivered: packet.delivered });
      return;
    }
  }

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const { frames, offset } = decodeFrames(buffer);
    if (offset > 0) buffer = buffer.slice(offset);
    frames.forEach(f => {
      if (f.opcode === 8) { socket.end(); return; }
      if (f.opcode === 1) { try { handleMessage(JSON.parse(f.payload.toString('utf8'))); } catch (e) {} }
    });
  });
  socket.on('close', () => { if (myId && clients.get(myId) === socket) clients.delete(myId); });
  socket.on('error', () => {});
});

const PORT = process.env.PORT || 8787;
httpServer.listen(PORT, () => console.log('OpenDesk messaging server listening on port ' + PORT));
