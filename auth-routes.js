// routes/auth.js
// -----------------------------------------------------------------------
// Signup / login / whoami, using a mobile number as the account
// identifier instead of email. Deliberately minimal — no OTP/SMS
// verification (that requires a paid SMS provider you'd need to
// configure), no password reset flow. Errors on login are intentionally
// generic ("invalid phone number or password") so a failed attempt can't
// be used to discover which numbers have accounts.
//
// New signups (teacher or student) require admin approval before they
// can log in — see db.approveUser / the admin "Pending approvals" UI.
// Only the seeded super-admin account and accounts a teacher/admin
// creates directly start out already active.
// -----------------------------------------------------------------------
const express = require('express');
const db = require('./database');
const auth = require('./auth-lib');
const { DEFAULT_STATE } = require('./default-state');

function buildAuthRouter() {
  const router = express.Router();

  router.post('/signup', async (req, res) => {
    const { phone, password, role, name } = req.body || {};
    if (!auth.isValidPhone(phone)) {
      return res.status(400).json({ ok: false, error: 'invalid_phone', message: 'Enter a valid mobile number.' });
    }
    if (!auth.isValidPassword(password)) {
      return res.status(400).json({ ok: false, error: 'password_too_short', message: 'Password must be at least 8 characters.' });
    }
    if (!auth.isValidRole(role)) {
      return res.status(400).json({ ok: false, error: 'invalid_role', message: 'Choose whether you are signing up as a teacher or a student.' });
    }
    if (db.findUserByPhone(phone)) {
      return res.status(409).json({ ok: false, error: 'account_exists', message: 'An account with that mobile number already exists.' });
    }
    const hash = await auth.hashPassword(password);
    const user = db.createUser(phone, hash, role, 'pending', (name || '').trim() || null);
    if (role === 'teacher') db.ensureDefaultsForUser(user.id, DEFAULT_STATE); // students read their teacher's data instead of having their own
    // No token issued yet — the account needs admin approval first.
    res.json({
      ok: true,
      pending: true,
      message: 'Account created. An admin needs to approve it before you can sign in — check back shortly.',
    });
  });

  router.post('/login', async (req, res) => {
    const { phone, password } = req.body || {};
    const user = db.findUserByPhone(phone);
    if (!user) return res.status(401).json({ ok: false, error: 'invalid_credentials', message: 'Invalid mobile number or password.' });
    const valid = await auth.verifyPassword(password || '', user.password_hash);
    if (!valid) return res.status(401).json({ ok: false, error: 'invalid_credentials', message: 'Invalid mobile number or password.' });
    if (user.status === 'pending') {
      return res.status(403).json({ ok: false, error: 'pending_approval', message: 'Your account is awaiting admin approval.' });
    }
    if (user.status !== 'active') {
      return res.status(403).json({ ok: false, error: 'account_restricted', message: 'Your account has been restricted by an admin. Contact your school admin for details.' });
    }
    db.touchLogin(user.id);
    const token = auth.signToken(user);
    res.json({ ok: true, token, user: { id: user.id, phone: user.phone, name: user.name, role: user.role } });
  });

  router.get('/me', auth.requireAuth, (req, res) => {
    const user = db.findUserById(req.user.id);
    if (!user || user.status !== 'active') return res.status(401).json({ ok: false, error: 'invalid_token' });
    res.json({ ok: true, user: { id: user.id, phone: user.phone, name: user.name, role: user.role } });
  });

  return router;
}

module.exports = { buildAuthRouter };
