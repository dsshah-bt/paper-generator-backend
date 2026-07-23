// routes/admin.js
// -----------------------------------------------------------------------
// Admin Layer — only reachable by the one super-admin account (seeded
// from ADMIN_PHONE/ADMIN_PASSWORD env vars, see server.js). The admin
// has FULL oversight: account management AND every user's actual data
// (question banks, saved papers, institution settings, etc.) — both
// read and write, going through the same conflict-resolution path as a
// normal save so nothing about the underlying data model changes.
// -----------------------------------------------------------------------
const express = require('express');
const db = require('./database');
const auth = require('./auth-lib');
const { DEFAULT_STATE } = require('./default-state');

function buildAdminRouter({ broadcast }) {
  const router = express.Router();
  router.use(auth.requireAuth, auth.requireAdmin);

  // ── Account management ──────────────────────────────────────────
  router.get('/users', (req, res) => {
    res.json({ ok: true, users: db.listUsers() });
  });

  // Pending signups awaiting approval before they can log in.
  router.get('/pending-users', (req, res) => {
    res.json({ ok: true, users: db.listPendingUsers() });
  });
  router.post('/users/:id/approve', (req, res) => {
    const targetId = Number(req.params.id);
    const user = db.findUserById(targetId);
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
    db.approveUser(targetId);
    res.json({ ok: true });
  });

  // Restrict an account — blocks login immediately AND invalidates any
  // session they're already using (requireAuth re-checks live status on
  // every request, not just at login — see auth-lib.js). For a teacher,
  // this also cuts off any students currently reading their content via
  // a classroom, since teacher-content checks the teacher's own status.
  router.post('/users/:id/suspend', (req, res) => {
    const targetId = Number(req.params.id);
    const user = db.findUserById(targetId);
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
    if (targetId === req.user.id) return res.status(400).json({ ok: false, error: 'cannot_suspend_self' });
    if (user.role === 'admin') return res.status(400).json({ ok: false, error: 'cannot_suspend_admin' });
    db.suspendUser(targetId);
    res.json({ ok: true });
  });

  router.post('/users/:id/reactivate', (req, res) => {
    const targetId = Number(req.params.id);
    const user = db.findUserById(targetId);
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
    db.reactivateUser(targetId);
    res.json({ ok: true });
  });

  // Live feed of question-bank and saved-paper activity across every
  // teacher, so the admin doesn't have to open "Manage in app" on each
  // one individually to see what's changed recently.
  router.get('/activity', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    res.json({ ok: true, activity: db.getRecentActivity(limit) });
  });

  // Admin-created accounts — lets the admin set someone up directly
  // (e.g. a teacher who'd rather be handed a login than self-register).
  // These start active immediately — no self-approval needed since the
  // admin created them directly and is trusting the account already.
  router.post('/users', async (req, res) => {
    const { phone, password, role, name } = req.body || {};
    if (!auth.isValidPhone(phone)) {
      return res.status(400).json({ ok: false, error: 'invalid_phone', message: 'Enter a valid mobile number.' });
    }
    if (!auth.isValidPassword(password)) {
      return res.status(400).json({ ok: false, error: 'password_too_short', message: 'Password must be at least 8 characters.' });
    }
    const finalRole = role === 'admin' ? 'admin' : (role === 'student' ? 'student' : 'teacher');
    if (db.findUserByPhone(phone)) {
      return res.status(409).json({ ok: false, error: 'account_exists', message: 'An account with that mobile number already exists.' });
    }
    const hash = await auth.hashPassword(password);
    const user = db.createUser(phone, hash, finalRole, 'active', (name || '').trim() || null);
    if (finalRole === 'teacher' || finalRole === 'admin') db.ensureDefaultsForUser(user.id, DEFAULT_STATE);
    res.json({ ok: true, user: { id: user.id, phone: user.phone, name: user.name, role: user.role, created_at: user.created_at } });
  });

  router.delete('/users/:id', (req, res) => {
    const id = Number(req.params.id);
    if (id === Number(req.user.id)) {
      return res.status(400).json({ ok: false, error: 'cannot_delete_self' });
    }
    db.deleteUser(id);
    res.json({ ok: true });
  });

  // ── Full data oversight ─────────────────────────────────────────
  // Every user's question bank, saved papers, institution settings,
  // etc. — readable and editable by the admin, exactly like the
  // account owner's own /api/state endpoints, just targeted at
  // someone else's user_id.
  router.get('/users/:id/state', (req, res) => {
    const targetId = Number(req.params.id);
    if (!db.findUserById(targetId)) return res.status(404).json({ ok: false, error: 'user_not_found' });
    res.json({ ok: true, state: db.readAll(targetId), serverTime: Date.now() });
  });

  router.get('/users/:id/state/:key', (req, res) => {
    const targetId = Number(req.params.id);
    if (!db.findUserById(targetId)) return res.status(404).json({ ok: false, error: 'user_not_found' });
    const slice = db.readSlice(targetId, req.params.key);
    if (!slice) return res.status(404).json({ ok: false, error: 'not_found' });
    res.json({ ok: true, slice });
  });

  router.get('/users/:id/state/:key/history', (req, res) => {
    const targetId = Number(req.params.id);
    if (!db.findUserById(targetId)) return res.status(404).json({ ok: false, error: 'user_not_found' });
    const limit = Math.min(Number(req.query.limit) || 20, 20);
    res.json({ ok: true, history: db.getHistory(targetId, req.params.key, limit) });
  });

  router.put('/users/:id/state/:key', (req, res) => {
    const targetId = Number(req.params.id);
    if (!db.findUserById(targetId)) return res.status(404).json({ ok: false, error: 'user_not_found' });
    const { value } = req.body || {};
    if (value === undefined) return res.status(400).json({ ok: false, error: 'missing_value' });
    try {
      // Tagged distinctly ("admin:<phone>") so version history and any
      // "last edited by" UI clearly shows an admin made the change, not
      // the account owner.
      const result = db.adminWriteSlice(targetId, req.params.key, value, 'admin:' + req.user.phone);
      // Push live to any of THAT user's open devices, same as a normal
      // save would — so if they have the app open, they see the admin's
      // edit appear immediately rather than being silently overwritten
      // on their next save.
      broadcast(targetId, { type: 'changed', key: req.params.key, updatedAt: result.slice.updatedAt, updatedBy: 'admin' }, null);
      res.json({ ok: true, slice: result.slice });
    } catch (err) {
      res.status(err.status || 500).json({ ok: false, error: err.message });
    }
  });

  // ── Full backup — every account and every one of their data areas,
  // as one downloadable JSON file. This is a manual safety net on top
  // of (not a replacement for) a properly configured persistent volume
  // — see README "Data safety" section for why that matters.
  router.get('/backup', (req, res) => {
    const users = db.listUsers();
    const backup = {
      exportedAt: Date.now(),
      users: users.map((u) => ({
        id: u.id, phone: u.phone, role: u.role, created_at: u.created_at, last_login_at: u.last_login_at,
        state: db.readAll(u.id),
      })),
    };
    res.setHeader('Content-Disposition', `attachment; filename="paper-generator-backup-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json(backup);
  });

  return router;
}

module.exports = { buildAdminRouter };
