// server.js
// -----------------------------------------------------------------------
// Paper Generator — Persistence Server
// Express REST API (SQLite-backed) + a lightweight WebSocket broadcast
// so open devices/tabs learn about changes within milliseconds instead
// of waiting for a poll. Every route (except /api/auth/signup and
// /api/auth/login) requires a valid account, and every account's data
// is completely isolated from every other account's.
// -----------------------------------------------------------------------
require('dotenv').config();
require('dotenv').config({ path: require('path').join(__dirname, '.env.local') }); // dev-only generated JWT secret, see auth.js
const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');

const db = require('./database');
const auth = require('./auth-lib');
const { buildApiRouter } = require('./api-routes');
const { buildAuthRouter } = require('./auth-routes');
const { buildAdminRouter } = require('./admin-routes');
const { buildClassroomRouter } = require('./classroom-routes');
const { DEFAULT_STATE } = require('./default-state');

const PORT = process.env.PORT || 8787;

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' })); // question banks / saved papers can get large

// ── Seed the one super-admin account from env vars, if configured. ──
// Re-running this on every boot is safe: if the account already exists
// it's just promoted to 'admin' and made active (in case it was created
// before you set these env vars), nothing is duplicated or overwritten.
if (process.env.ADMIN_PHONE && process.env.ADMIN_PASSWORD) {
  (async () => {
    const phone = process.env.ADMIN_PHONE;
    let user = db.findUserByPhone(phone);
    if (!user) {
      const hash = await auth.hashPassword(process.env.ADMIN_PASSWORD);
      user = db.createUser(phone, hash, 'admin', 'active'); // admin accounts are always active immediately, never pending
      db.ensureDefaultsForUser(user.id, DEFAULT_STATE);
      console.log(`[admin] Created super-admin account for ${phone}`);
    } else {
      if (user.role !== 'admin') db.promoteToAdmin(user.id);
      if (user.status !== 'active') db.approveUser(user.id);
    }
  })().catch((e) => console.error('[admin] Failed to seed admin account:', e));
} else {
  console.warn('[admin] ADMIN_PHONE / ADMIN_PASSWORD not set — no admin account will be created. See .env.example.');
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// ws -> { deviceId, userId }
const clients = new Map();

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const deviceId = url.searchParams.get('deviceId') || null;
  const token = url.searchParams.get('token');
  const payload = token ? auth.verifyTokenOrNull(token) : null;

  if (!payload) {
    ws.close(4001, 'unauthorized');
    return;
  }

  clients.set(ws, { deviceId, userId: payload.sub });
  ws.on('close', () => clients.delete(ws));
  ws.send(JSON.stringify({ type: 'hello', serverTime: Date.now() }));
});

// Only pushes to OTHER connections on the SAME account — never crosses
// accounts, and never echoes back to the device that made the change.
function broadcast(userId, message, fromDeviceId) {
  const payload = JSON.stringify(message);
  for (const [ws, info] of clients.entries()) {
    if (String(info.userId) !== String(userId)) continue;
    if (info.deviceId && info.deviceId === fromDeviceId) continue;
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

app.use('/api/auth', buildAuthRouter());
app.use('/api/admin', buildAdminRouter({ broadcast }));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: Date.now(), connectedClients: clients.size });
});

app.use('/api', auth.requireAuth, buildApiRouter({ broadcast }));
app.use('/api/classroom', auth.requireAuth, buildClassroomRouter({ broadcast }));

// Serve the frontend itself directly (app.html — kept in this same
// flat directory, no subfolder, so it can't get lost during a
// drag/upload that doesn't preserve folder structure).
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'app.html'));
});

server.listen(PORT, () => {
  console.log(`Paper Generator backend listening on port ${PORT}`);
  console.log(`  REST API:  http://localhost:${PORT}/api`);
  console.log(`  WebSocket: ws://localhost:${PORT}/ws`);
});
