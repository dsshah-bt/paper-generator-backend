// auth.js
// -----------------------------------------------------------------------
// Auth Layer
// Password hashing (bcryptjs — pure JS, no native compile step) + JWT
// issuing/verification (jsonwebtoken — also pure JS) + Express
// middleware. Tokens are accepted either as a normal
// "Authorization: Bearer <token>" header (used by fetch calls) or as a
// "?token=" query param (needed for the two browser APIs that can't set
// custom headers: WebSocket and navigator.sendBeacon).
// -----------------------------------------------------------------------
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./database');

const TOKEN_TTL = '30d';
const SECRET = resolveSecret();

function resolveSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;

  // Dev convenience only: persist a generated secret to .env.local so
  // restarts on the SAME machine keep working without you doing
  // anything. On ephemeral/read-only hosts this write silently fails
  // and the warning below tells you what to do instead.
  const devSecretPath = path.join(__dirname, '.env.local');
  try {
    if (fs.existsSync(devSecretPath)) {
      const existing = fs.readFileSync(devSecretPath, 'utf8').match(/JWT_SECRET=(.+)/);
      if (existing) return existing[1].trim();
    }
    const generated = crypto.randomBytes(48).toString('hex');
    fs.writeFileSync(devSecretPath, `JWT_SECRET=${generated}\n`);
    console.warn(
      '[auth] No JWT_SECRET set — generated one and saved it to backend/.env.local for local dev.\n' +
      '        In production, set the JWT_SECRET environment variable yourself, or every\n' +
      '        deploy/restart will invalidate everyone\'s login.'
    );
    return generated;
  } catch (e) {
    const generated = crypto.randomBytes(48).toString('hex');
    console.warn(
      '[auth] No JWT_SECRET set and could not persist one to disk — using a throwaway secret ' +
      'for this process only. Every restart will log everyone out. Set JWT_SECRET yourself to fix this.'
    );
    return generated;
  }
}

function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

function signToken(user) {
  return jwt.sign({ sub: user.id, phone: user.phone, role: user.role }, SECRET, { expiresIn: TOKEN_TTL });
}

function verifyToken(token) {
  return jwt.verify(token, SECRET); // throws if invalid/expired
}

function extractToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  if (req.query && req.query.token) return req.query.token;
  return null;
}

function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ ok: false, error: 'missing_token' });
  try {
    const payload = verifyToken(token);
    // The JWT itself never expires early even if an admin suspends the
    // account mid-session — it's just a signed claim. So every request
    // re-checks the CURRENT database status, not just what was true at
    // login. This is what makes "restrict a user" actually immediate
    // instead of only blocking their next login attempt.
    const liveUser = db.findUserById(payload.sub);
    if (!liveUser || liveUser.status !== 'active') {
      return res.status(403).json({ ok: false, error: 'account_restricted', message: 'This account is no longer active.' });
    }
    req.user = { id: liveUser.id, phone: liveUser.phone, name: liveUser.name, role: liveUser.role };
    next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: 'invalid_token' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ ok: false, error: 'admin_only' });
  }
  next();
}

function requireTeacher(req, res, next) {
  if (!req.user || (req.user.role !== 'teacher' && req.user.role !== 'admin')) {
    return res.status(403).json({ ok: false, error: 'teacher_only' });
  }
  next();
}

function requireStudent(req, res, next) {
  if (!req.user || req.user.role !== 'student') {
    return res.status(403).json({ ok: false, error: 'student_only' });
  }
  next();
}

// Used by the WebSocket upgrade handler, which has no Express req/res.
// Also re-checks live account status, same reasoning as requireAuth.
function verifyTokenOrNull(token) {
  try {
    const payload = verifyToken(token);
    const liveUser = db.findUserById(payload.sub);
    if (!liveUser || liveUser.status !== 'active') return null;
    return payload;
  } catch (e) { return null; }
}

// Accepts an optional leading "+" then 7-15 digits (spaces/dashes/
// parens are stripped before this check runs, in routes/auth.js).
const PHONE_RE = /^\+?[0-9]{7,15}$/;
function isValidPhone(phone) { return PHONE_RE.test(String(phone || '').trim()); }
function isValidPassword(password) { return typeof password === 'string' && password.length >= 8; }
function isValidRole(role) { return role === 'teacher' || role === 'student'; }

module.exports = {
  hashPassword, verifyPassword, signToken, verifyToken, verifyTokenOrNull,
  requireAuth, requireAdmin, requireTeacher, requireStudent, isValidPhone, isValidPassword, isValidRole,
};
