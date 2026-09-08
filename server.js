require('dotenv').config();
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL belum di-set. Isi file .env (lihat .env.example).');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
});

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
function genCode() {
  let s = '';
  for (let i = 0; i < 4; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return s;
}
function isValidCode(c) {
  return typeof c === 'string' && /^[A-Z]{4}$/.test(c);
}
const DEFAULT_RULES = { trade: true, auction: true, pot: true, goBonus: true, jailNoRent: false };
const TOKENS = ['🐧', '🦊', '🐙', '🤖', '🐳', '👾'];
const COLORS = ['#7ee787', '#82aaff', '#ff6b7d', '#ffd866', '#c792ea', '#56d4dd'];
function usedPalette(seats) {
  return { toks: seats.filter(Boolean).map(s => s.tok), cols: seats.filter(Boolean).map(s => s.color) };
}
function pickUnused(pool_, used) {
  return pool_.find(x => used.indexOf(x) < 0) || pool_[Math.floor(Math.random() * pool_.length)];
}

/* =========================================================
   In-memory room registry — single-instance server.
   Postgres is the durability layer; broadcasts are in-process.
========================================================= */
const rooms = new Map(); // code -> { lobby, game, clients:Set<ws>, peers:Map<clientId,{seat}> }

async function loadRoomFromDb(code) {
  const r = await pool.query('SELECT lobby, game FROM rooms WHERE code = $1', [code]);
  if (!r.rows.length) return null;
  return { lobby: r.rows[0].lobby, game: r.rows[0].game, clients: new Set(), peers: new Map() };
}
async function persistRoom(code, room) {
  try {
    await pool.query(
      'UPDATE rooms SET lobby = $2, game = $3, updated_at = now() WHERE code = $1',
      [code, room.lobby, room.game]
    );
  } catch (e) {
    console.error('persist error', code, e.message);
  }
}
async function getOrLoadRoom(code) {
  if (rooms.has(code)) return rooms.get(code);
  const loaded = await loadRoomFromDb(code);
  if (!loaded) return null;
  rooms.set(code, loaded);
  return loaded;
}

function broadcast(room, msg, exceptWs) {
  const data = JSON.stringify(msg);
  room.clients.forEach(ws => {
    if (ws === exceptWs) return;
    if (ws.readyState === ws.OPEN) ws.send(data);
  });
}
function broadcastAll(room, msg) {
  const data = JSON.stringify(msg);
  room.clients.forEach(ws => { if (ws.readyState === ws.OPEN) ws.send(data); });
}
function peersList(room) {
  return [...room.peers.entries()].map(([clientId, p]) => ({ clientId, seat: p.seat }));
}

/* =========================================================
   HTTP + static frontend
========================================================= */
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (req, res) => res.json({ ok: true, rooms: rooms.size }));

const server = app.listen(PORT, () => console.log('monopoli-nusantara server listening on :' + PORT));

/* =========================================================
   WebSocket protocol
========================================================= */
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.roomCode = null;
  ws.clientId = null;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', async raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg.t !== 'string') return;
    const reply = (payload) => {
      if (msg.reqId) ws.send(JSON.stringify(Object.assign({ t: 'reply', reqId: msg.reqId }, payload)));
    };

    try {
      if (msg.t === 'host') {
        let code = null;
        for (let i = 0; i < 8; i++) {
          const c = genCode();
          const exists = rooms.has(c) || (await pool.query('SELECT 1 FROM rooms WHERE code=$1', [c])).rows.length;
          if (!exists) { code = c; break; }
        }
        if (!code) return reply({ ok: false, error: 'gagal membuat kode room' });
        const lobby = { status: 'lobby', seats: [null, null, null, null, null, null], rules: Object.assign({}, DEFAULT_RULES), startingCash: 1500, createdAt: Date.now() };
        await pool.query('INSERT INTO rooms(code, lobby, game) VALUES ($1,$2,$3)', [code, lobby, null]);
        rooms.set(code, { lobby, game: null, clients: new Set(), peers: new Map() });
        return reply({ ok: true, code });
      }

      if (msg.t === 'join') {
        const code = String(msg.code || '').toUpperCase();
        if (!isValidCode(code)) return reply({ ok: false, error: 'kode tidak valid' });
        const room = await getOrLoadRoom(code);
        if (!room) return reply({ ok: false, error: 'room tidak ditemukan' });
        if (ws.roomCode && ws.roomCode !== code) room.clients.delete(ws);
        ws.roomCode = code;
        room.clients.add(ws);
        return reply({ ok: true, lobby: room.lobby, game: room.game });
      }

      if (msg.t === 'leave') {
        const code = ws.roomCode;
        if (code && rooms.has(code)) {
          const room = rooms.get(code);
          room.clients.delete(ws);
          if (ws.clientId && room.peers.has(ws.clientId)) {
            room.peers.delete(ws.clientId);
            broadcastAll(room, { t: 'peers', list: peersList(room) });
          }
        }
        ws.roomCode = null;
        return reply({ ok: true });
      }

      if (msg.t === 'claimSeat') {
        const code = String(msg.code || '').toUpperCase();
        const clientId = String(msg.clientId || '');
        const room = rooms.get(code);
        if (!room || !clientId) return reply({ ok: false, error: 'room tidak ditemukan' });
        const seats = room.lobby.seats.slice();
        let idx = seats.findIndex(s => s && s.clientId === clientId);
        if (idx < 0) {
          idx = seats.findIndex(s => !s);
          if (idx < 0) return reply({ ok: false, error: 'room penuh' });
          const palette = usedPalette(seats);
          seats[idx] = { clientId, name: 'player_' + (idx + 1), tok: pickUnused(TOKENS, palette.toks), color: pickUnused(COLORS, palette.cols), cpu: false };
          room.lobby = Object.assign({}, room.lobby, { seats });
          persistRoom(code, room);
          broadcastAll(room, { t: 'lobby', data: room.lobby });
        }
        return reply({ ok: true, seat: idx });
      }

      if (msg.t === 'lobbyPatch') {
        const code = String(msg.code || '').toUpperCase();
        const room = rooms.get(code);
        if (!room || !msg.patch || typeof msg.patch !== 'object') return reply({ ok: false });
        const allowed = ['seats', 'rules', 'startingCash', 'status'];
        const patch = {};
        allowed.forEach(k => { if (k in msg.patch) patch[k] = msg.patch[k]; });
        room.lobby = Object.assign({}, room.lobby, patch);
        persistRoom(code, room);
        broadcastAll(room, { t: 'lobby', data: room.lobby });
        return reply({ ok: true });
      }

      if (msg.t === 'gameSet') {
        const code = String(msg.code || '').toUpperCase();
        const room = rooms.get(code);
        if (!room || !msg.game) return reply({ ok: false });
        room.game = msg.game;
        persistRoom(code, room);
        broadcastAll(room, { t: 'game', data: room.game });
        return reply({ ok: true });
      }

      if (msg.t === 'presence') {
        const code = String(msg.code || '').toUpperCase();
        const room = rooms.get(code);
        if (!room) return;
        ws.clientId = String(msg.clientId || '');
        room.peers.set(ws.clientId, { seat: msg.seat });
        broadcastAll(room, { t: 'peers', list: peersList(room) });
        return;
      }
    } catch (e) {
      console.error('ws message error', e);
      reply({ ok: false, error: 'server error' });
    }
  });

  ws.on('close', () => {
    const code = ws.roomCode;
    if (code && rooms.has(code)) {
      const room = rooms.get(code);
      room.clients.delete(ws);
      if (ws.clientId && room.peers.has(ws.clientId)) {
        room.peers.delete(ws.clientId);
        broadcastAll(room, { t: 'peers', list: peersList(room) });
      }
    }
  });
});

// heartbeat: drop dead sockets
const heartbeat = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);
wss.on('close', () => clearInterval(heartbeat));

/* =========================================================
   Schema bootstrap + light cleanup of very old rooms
========================================================= */
async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rooms (
      code TEXT PRIMARY KEY,
      lobby JSONB NOT NULL,
      game JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`DELETE FROM rooms WHERE updated_at < now() - interval '3 days'`);
}
initSchema().catch(e => { console.error('schema init failed', e); process.exit(1); });
