// db/database.js
// -----------------------------------------------------------------------
// Database Layer
// Thin wrapper around Node's built-in SQLite (node:sqlite, stable since
// Node 22.5+). Using the built-in module instead of a native npm package
// (e.g. better-sqlite3) avoids native-compile/prebuilt-binary problems
// on hosts and keeps deployment to "npm install && node server.js" with
// zero native build steps.
// -----------------------------------------------------------------------
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'paper_generator.db');
const MAX_HISTORY_PER_KEY = 20;

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON;');
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

// ── Migration for databases created before the classroom/approval
// features existed: CREATE TABLE IF NOT EXISTS doesn't add new columns
// to an already-existing users table, so add it explicitly here. Wrapped
// in try/catch because this throws harmlessly on a fresh DB where the
// column already came from schema.sql. Existing rows get 'active' via
// the column default, so nobody already using the app gets locked out
// by the new approval requirement, and legacy role='user' accounts
// (everyone before this feature) are treated as teachers going forward.
try { db.exec(`ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`); } catch (e) {}
try { db.exec(`ALTER TABLE users ADD COLUMN name TEXT`); } catch (e) {}
try { db.exec(`ALTER TABLE assignments ADD COLUMN time_limit_minutes INTEGER`); } catch (e) {}
try { db.exec(`UPDATE users SET role='teacher' WHERE role='user'`); } catch (e) {}

const KNOWN_KEYS = [
  'institution',
  'paper_patterns',
  'question_bank',
  'saved_papers',
  'custom_classes',
  'custom_chapters',
  'custom_qtypes',
  'deleted_builtins',
];

function now() { return Date.now(); }

// ---------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------
const userStmts = {
  insert: db.prepare(`INSERT INTO users (phone, name, password_hash, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`),
  byPhone: db.prepare(`SELECT * FROM users WHERE phone = ?`),
  byId: db.prepare(`SELECT * FROM users WHERE id = ?`),
  touchLogin: db.prepare(`UPDATE users SET last_login_at = ? WHERE id = ?`),
  setRole: db.prepare(`UPDATE users SET role = ? WHERE id = ?`),
  setStatus: db.prepare(`UPDATE users SET status = ? WHERE id = ?`),
  all: db.prepare(`SELECT id, phone, name, role, status, created_at, last_login_at FROM users ORDER BY created_at ASC`),
  pending: db.prepare(`SELECT id, phone, name, role, status, created_at FROM users WHERE status='pending' ORDER BY created_at ASC`),
  studentsByPhoneSearch: db.prepare(`SELECT id, phone, name, role, status FROM users WHERE role='student' AND status='active' AND phone LIKE ?`),
  deleteById: db.prepare(`DELETE FROM users WHERE id = ?`),
};

function normalizePhone(phone) {
  // Keep a leading "+" if present, strip everything else non-digit.
  var s = String(phone || '').trim();
  var plus = s.startsWith('+') ? '+' : '';
  return plus + s.replace(/[^0-9]/g, '');
}

// New signups default to 'pending' (admin must approve before they can
// log in) unless explicitly created active — used for the one seeded
// super-admin account and for admin-created accounts, which are
// trusted by construction and shouldn't need self-approval.
function createUser(phone, passwordHash, role, status, name) {
  phone = normalizePhone(phone);
  const info = userStmts.insert.run(phone, name || null, passwordHash, role || 'teacher', status || 'pending', now());
  return userStmts.byId.get(info.lastInsertRowid);
}

function findUserByPhone(phone) {
  return userStmts.byPhone.get(normalizePhone(phone));
}

function findUserById(id) {
  return userStmts.byId.get(id);
}

function touchLogin(userId) {
  userStmts.touchLogin.run(now(), userId);
}

function promoteToAdmin(userId) {
  userStmts.setRole.run('admin', userId);
}

function listUsers() {
  return userStmts.all.all();
}

function listPendingUsers() {
  return userStmts.pending.all();
}

function approveUser(userId) {
  userStmts.setStatus.run('active', userId);
}

function suspendUser(userId) {
  userStmts.setStatus.run('suspended', userId);
}

function reactivateUser(userId) {
  userStmts.setStatus.run('active', userId);
}

function searchStudentsByPhone(partialPhone) {
  return userStmts.studentsByPhoneSearch.all('%' + normalizePhone(partialPhone) + '%');
}

function deleteUser(userId) {
  // ON DELETE CASCADE (foreign_keys pragma is on) removes their
  // app_state / state_history / devices rows automatically.
  userStmts.deleteById.run(userId);
}

// ---------------------------------------------------------------------
// Admin activity feed — every save already gets logged into
// state_history (that's what powers per-slice version history); this
// just reads it back across EVERY account instead of one, so the admin
// can see "who changed what, when" without opening each teacher
// individually. Scoped to the two areas that matter for oversight —
// question_bank and saved_papers — since institution/settings/etc.
// changes aren't meaningful activity to surface.
// ---------------------------------------------------------------------
const activityStmt = db.prepare(`
  SELECT sh.id, sh.user_id, sh.key, sh.value, sh.version, sh.updated_at, sh.updated_by,
         u.phone AS user_phone, u.name AS user_name
  FROM state_history sh
  JOIN users u ON u.id = sh.user_id
  WHERE sh.key IN ('question_bank', 'saved_papers') AND u.role = 'teacher'
  ORDER BY sh.updated_at DESC
  LIMIT ?
`);

function getRecentActivity(limit = 50) {
  return activityStmt.all(limit).map((row) => {
    let summary = '';
    try {
      const value = JSON.parse(row.value);
      if (row.key === 'question_bank') {
        const chapterCount = Object.keys(value).length;
        const questionCount = Object.values(value).reduce((sum, types) => {
          return sum + Object.values(types).reduce((s2, arr) => s2 + (Array.isArray(arr) ? arr.length : 0), 0);
        }, 0);
        summary = `Question Bank — ${chapterCount} chapter${chapterCount === 1 ? '' : 's'}, ${questionCount} question${questionCount === 1 ? '' : 's'} total`;
      } else if (row.key === 'saved_papers') {
        summary = `Saved Papers — ${Array.isArray(value) ? value.length : 0} paper${(Array.isArray(value) ? value.length : 0) === 1 ? '' : 's'} total`;
      }
    } catch (e) { summary = row.key; }
    return {
      userId: row.user_id, userPhone: row.user_phone, userName: row.user_name,
      key: row.key, version: row.version, updatedAt: row.updated_at, updatedBy: row.updated_by, summary,
    };
  });
}

// ---------------------------------------------------------------------
// App state — every query now scoped by user_id.
// ---------------------------------------------------------------------
const stmts = {
  get: db.prepare('SELECT key, value, version, updated_at, updated_by FROM app_state WHERE user_id = ? AND key = ?'),
  getAll: db.prepare('SELECT key, value, version, updated_at, updated_by FROM app_state WHERE user_id = ?'),
  getChangedSince: db.prepare('SELECT key, value, version, updated_at, updated_by FROM app_state WHERE user_id = ? AND updated_at > ?'),
  upsert: db.prepare(`
    INSERT INTO app_state (user_id, key, value, version, updated_at, updated_by)
    VALUES (?, ?, ?, 1, ?, ?)
    ON CONFLICT(user_id, key) DO UPDATE SET
      value = excluded.value,
      version = version + 1,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by
  `),
  insertHistory: db.prepare(`
    INSERT INTO state_history (user_id, key, value, version, updated_at, updated_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  trimHistory: db.prepare(`
    DELETE FROM state_history
    WHERE user_id = ? AND key = ? AND id NOT IN (
      SELECT id FROM state_history WHERE user_id = ? AND key = ? ORDER BY id DESC LIMIT ?
    )
  `),
  historyForKey: db.prepare('SELECT id, value, version, updated_at, updated_by FROM state_history WHERE user_id = ? AND key = ? ORDER BY id DESC LIMIT ?'),
  upsertDevice: db.prepare(`
    INSERT INTO devices (device_id, user_id, label, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET user_id = excluded.user_id, label = excluded.label, last_seen = excluded.last_seen
  `),
};

function readSlice(userId, key) {
  const row = stmts.get.get(userId, key);
  if (!row) return null;
  return { key: row.key, value: JSON.parse(row.value), version: row.version, updatedAt: row.updated_at, updatedBy: row.updated_by };
}

function readAll(userId) {
  const rows = stmts.getAll.all(userId);
  const out = {};
  for (const row of rows) {
    out[row.key] = { value: JSON.parse(row.value), version: row.version, updatedAt: row.updated_at, updatedBy: row.updated_by };
  }
  return out;
}

function readChangedSince(userId, ts) {
  const rows = stmts.getChangedSince.all(userId, ts);
  const out = {};
  for (const row of rows) {
    out[row.key] = { value: JSON.parse(row.value), version: row.version, updatedAt: row.updated_at, updatedBy: row.updated_by };
  }
  return out;
}

// Core conflict resolution: timestamp-based, latest edit wins (within
// one account — different accounts never see each other's data).
function writeSlice(userId, key, value, clientUpdatedAt, deviceId) {
  if (!KNOWN_KEYS.includes(key)) {
    throw Object.assign(new Error(`Unknown state key: ${key}`), { status: 400 });
  }
  const existing = stmts.get.get(userId, key);
  const ts = now();
  const incomingTs = Number.isFinite(clientUpdatedAt) ? clientUpdatedAt : ts;

  if (existing && existing.updated_at > incomingTs) {
    return { accepted: false, slice: readSlice(userId, key) };
  }

  stmts.upsert.run(userId, key, JSON.stringify(value), ts, deviceId || null);
  const saved = stmts.get.get(userId, key);
  stmts.insertHistory.run(userId, key, JSON.stringify(value), saved.version, ts, deviceId || null);
  stmts.trimHistory.run(userId, key, userId, key, MAX_HISTORY_PER_KEY);

  return { accepted: true, slice: readSlice(userId, key) };
}

function getHistory(userId, key, limit = 20) {
  return stmts.historyForKey.all(userId, key, limit).map(r => ({
    id: r.id, value: JSON.parse(r.value), version: r.version, updatedAt: r.updated_at, updatedBy: r.updated_by,
  }));
}

// Admin oversight: identical write path to writeSlice, but callable on
// ANY user's data and always tagged with a distinct updatedBy label so
// it's visible in history/UI that an admin (not the account owner) made
// the change. Still goes through the same conflict-resolution logic.
function adminWriteSlice(targetUserId, key, value, deviceLabel) {
  return writeSlice(targetUserId, key, value, Date.now(), deviceLabel || 'admin');
}

function touchDevice(userId, deviceId, label) {
  if (!deviceId) return;
  const ts = now();
  stmts.upsertDevice.run(deviceId, userId || null, label || null, ts, ts);
}

function ensureDefaultsForUser(userId, defaults) {
  // Seed a brand-new account with the app's built-in defaults so their
  // first load matches what the app itself expects instead of 404ing.
  // Students don't get a private question_bank/saved_papers of their
  // own — they read their teacher's via the classroom routes instead —
  // so this is a no-op for them beyond whatever KNOWN_KEYS apply.
  for (const key of KNOWN_KEYS) {
    const existing = stmts.get.get(userId, key);
    if (!existing && key in defaults) {
      stmts.upsert.run(userId, key, JSON.stringify(defaults[key]), now(), 'seed');
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// Classroom layer
// ═══════════════════════════════════════════════════════════════════
const classroomStmts = {
  insert: db.prepare(`INSERT INTO classrooms (teacher_id, name, created_at) VALUES (?, ?, ?)`),
  byId: db.prepare(`SELECT * FROM classrooms WHERE id = ?`),
  byTeacher: db.prepare(`SELECT * FROM classrooms WHERE teacher_id = ? ORDER BY created_at DESC`),
  delete: db.prepare(`DELETE FROM classrooms WHERE id = ?`),
  addStudent: db.prepare(`INSERT OR IGNORE INTO classroom_students (classroom_id, student_id, added_at) VALUES (?, ?, ?)`),
  removeStudent: db.prepare(`DELETE FROM classroom_students WHERE classroom_id = ? AND student_id = ?`),
  roster: db.prepare(`
    SELECT u.id, u.phone, u.name, u.status FROM classroom_students cs
    JOIN users u ON u.id = cs.student_id WHERE cs.classroom_id = ? ORDER BY cs.added_at ASC
  `),
  studentClassrooms: db.prepare(`
    SELECT c.id, c.name, c.teacher_id, u.phone AS teacher_phone, u.name AS teacher_name, c.created_at FROM classroom_students cs
    JOIN classrooms c ON c.id = cs.classroom_id
    JOIN users u ON u.id = c.teacher_id
    WHERE cs.student_id = ? ORDER BY c.created_at DESC
  `),
  isMember: db.prepare(`SELECT 1 FROM classroom_students WHERE classroom_id = ? AND student_id = ?`),
};

function createClassroom(teacherId, name) {
  const info = classroomStmts.insert.run(teacherId, name, now());
  return classroomStmts.byId.get(info.lastInsertRowid);
}
function getClassroom(id) { return classroomStmts.byId.get(id); }
function listClassroomsForTeacher(teacherId) { return classroomStmts.byTeacher.all(teacherId); }
function deleteClassroom(id) { classroomStmts.delete.run(id); }
function addStudentToClassroom(classroomId, studentId) { classroomStmts.addStudent.run(classroomId, studentId, now()); }
function removeStudentFromClassroom(classroomId, studentId) { classroomStmts.removeStudent.run(classroomId, studentId); }
function getClassroomRoster(classroomId) { return classroomStmts.roster.all(classroomId); }
function listClassroomsForStudent(studentId) { return classroomStmts.studentClassrooms.all(studentId); }
function isStudentInClassroom(classroomId, studentId) { return !!classroomStmts.isMember.get(classroomId, studentId); }

// ═══════════════════════════════════════════════════════════════════
// Assignments + Submissions
// ═══════════════════════════════════════════════════════════════════
const assignmentStmts = {
  insert: db.prepare(`
    INSERT INTO assignments (classroom_id, teacher_id, type, title, instructions, questions, due_at, time_limit_minutes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  byId: db.prepare(`SELECT * FROM assignments WHERE id = ?`),
  byClassroom: db.prepare(`SELECT * FROM assignments WHERE classroom_id = ? ORDER BY created_at DESC`),
  delete: db.prepare(`DELETE FROM assignments WHERE id = ?`),
};
const submissionStmts = {
  insert: db.prepare(`
    INSERT INTO submissions (assignment_id, student_id, answers, status, score, max_score, submitted_at, graded_at, graded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(assignment_id, student_id) DO UPDATE SET
      answers=excluded.answers, status=excluded.status, score=excluded.score, max_score=excluded.max_score,
      submitted_at=excluded.submitted_at, graded_at=excluded.graded_at, graded_by=excluded.graded_by
  `),
  byAssignmentAndStudent: db.prepare(`SELECT * FROM submissions WHERE assignment_id = ? AND student_id = ?`),
  byAssignment: db.prepare(`
    SELECT s.*, u.phone AS student_phone, u.name AS student_name FROM submissions s JOIN users u ON u.id = s.student_id
    WHERE s.assignment_id = ? ORDER BY s.submitted_at ASC
  `),
  byStudent: db.prepare(`SELECT * FROM submissions WHERE student_id = ?`),
  grade: db.prepare(`UPDATE submissions SET score=?, max_score=?, status='graded', graded_at=?, graded_by=? WHERE id=?`),
  byId: db.prepare(`SELECT * FROM submissions WHERE id = ?`),
};
const announcementStmts = {
  insert: db.prepare(`INSERT INTO announcements (classroom_id, teacher_id, message, created_at) VALUES (?, ?, ?, ?)`),
  byClassroom: db.prepare(`SELECT * FROM announcements WHERE classroom_id = ? ORDER BY created_at DESC LIMIT 50`),
  delete: db.prepare(`DELETE FROM announcements WHERE id = ?`),
  byId: db.prepare(`SELECT * FROM announcements WHERE id = ?`),
};

function createAssignment(classroomId, teacherId, type, title, instructions, questions, dueAt, timeLimitMinutes) {
  const info = assignmentStmts.insert.run(classroomId, teacherId, type, title, instructions || '', JSON.stringify(questions), dueAt || null, timeLimitMinutes || null, now());
  return getAssignment(info.lastInsertRowid);
}
function getAssignment(id) {
  const row = assignmentStmts.byId.get(id);
  if (!row) return null;
  return { ...row, questions: JSON.parse(row.questions) };
}
function listAssignmentsForClassroom(classroomId) {
  return assignmentStmts.byClassroom.all(classroomId).map(r => ({ ...r, questions: JSON.parse(r.questions) }));
}
function deleteAssignment(id) { assignmentStmts.delete.run(id); }

function createAnnouncement(classroomId, teacherId, message) {
  const info = announcementStmts.insert.run(classroomId, teacherId, message, now());
  return announcementStmts.byId.get(info.lastInsertRowid);
}
function listAnnouncementsForClassroom(classroomId) {
  return announcementStmts.byClassroom.all(classroomId);
}
function deleteAnnouncement(id) { announcementStmts.delete.run(id); }
function getAnnouncement(id) { return announcementStmts.byId.get(id); }

function submitAssignment(assignmentId, studentId, answers, status, score, maxScore, gradedBy) {
  const ts = now();
  submissionStmts.insert.run(
    assignmentId, studentId, JSON.stringify(answers), status,
    score == null ? null : score, maxScore == null ? null : maxScore,
    ts, status === 'graded' ? ts : null, status === 'graded' ? (gradedBy || 'auto') : null
  );
  return getSubmission(assignmentId, studentId);
}
function getSubmission(assignmentId, studentId) {
  const row = submissionStmts.byAssignmentAndStudent.get(assignmentId, studentId);
  if (!row) return null;
  return { ...row, answers: JSON.parse(row.answers) };
}
function getSubmissionById(id) {
  const row = submissionStmts.byId.get(id);
  if (!row) return null;
  return { ...row, answers: JSON.parse(row.answers) };
}
function listSubmissionsForAssignment(assignmentId) {
  return submissionStmts.byAssignment.all(assignmentId).map(r => ({ ...r, answers: JSON.parse(r.answers) }));
}
function listSubmissionsForStudent(studentId) {
  return submissionStmts.byStudent.all(studentId).map(r => ({ ...r, answers: JSON.parse(r.answers) }));
}
function gradeSubmission(submissionId, score, maxScore, gradedByPhone) {
  submissionStmts.grade.run(score, maxScore, now(), gradedByPhone, submissionId);
  return getSubmissionById(submissionId);
}

module.exports = {
  KNOWN_KEYS,
  // state
  readSlice, readAll, readChangedSince, writeSlice, getHistory, touchDevice, ensureDefaultsForUser, adminWriteSlice,
  // users
  createUser, findUserByPhone, findUserById, touchLogin, promoteToAdmin, listUsers, deleteUser,
  listPendingUsers, approveUser, searchStudentsByPhone, suspendUser, reactivateUser,
  // activity
  getRecentActivity,
  // classrooms
  createClassroom, getClassroom, listClassroomsForTeacher, deleteClassroom,
  addStudentToClassroom, removeStudentFromClassroom, getClassroomRoster,
  listClassroomsForStudent, isStudentInClassroom,
  // assignments + submissions
  createAssignment, getAssignment, listAssignmentsForClassroom, deleteAssignment,
  submitAssignment, getSubmission, getSubmissionById, listSubmissionsForAssignment,
  listSubmissionsForStudent, gradeSubmission,
  // announcements
  createAnnouncement, listAnnouncementsForClassroom, deleteAnnouncement, getAnnouncement,
};
