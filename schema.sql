-- Paper Generator — Persistence Schema
-- Design note: the app's own data model already treats each major area
-- (institution settings, paper patterns, question bank, saved papers,
-- custom taxonomy) as one cohesive JSON object in memory. Rather than
-- forcing a deep relational split that would require rewriting large
-- parts of the app's existing business logic (high risk of breaking
-- Question Bank / Generate Paper / Preview / etc.), each area is stored
-- as its own versioned row ("slice"), now scoped per account. This still
-- gives real IDs, real tables, real timestamps, and real per-slice
-- conflict resolution — just at the slice level rather than the
-- individual-field level.

CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  phone           TEXT UNIQUE NOT NULL,
  name            TEXT,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'user', -- 'admin' | 'teacher' | 'student' (legacy 'user' == 'teacher')
  status          TEXT NOT NULL DEFAULT 'active', -- 'pending' | 'active' — new signups start 'pending' until admin approves
  created_at      INTEGER NOT NULL,
  last_login_at   INTEGER
);

-- ══════════════════════════════════════════════════════════════════
-- Classroom layer — Google-Classroom-style: a teacher creates one or
-- more classrooms, adds students to each by phone number, then posts
-- assignments (free-text, teacher-graded) or MCQ tests (auto-graded
-- the instant a student submits) to a classroom. A student can belong
-- to several classrooms across different teachers.
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS classrooms (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_id  INTEGER NOT NULL,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (teacher_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS classroom_students (
  classroom_id  INTEGER NOT NULL,
  student_id    INTEGER NOT NULL,
  added_at      INTEGER NOT NULL,
  PRIMARY KEY (classroom_id, student_id),
  FOREIGN KEY (classroom_id) REFERENCES classrooms(id) ON DELETE CASCADE,
  FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS assignments (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  classroom_id        INTEGER NOT NULL,
  teacher_id          INTEGER NOT NULL,
  type                TEXT NOT NULL,          -- 'assignment' (free-text, manually graded) | 'mcq_test' (auto-graded)
  title               TEXT NOT NULL,
  instructions        TEXT,
  questions           TEXT NOT NULL,          -- JSON array; shape differs by type (see admin-routes/classroom-routes comments)
  due_at              INTEGER,
  time_limit_minutes  INTEGER,                -- mcq_test only; null = no limit
  created_at          INTEGER NOT NULL,
  FOREIGN KEY (classroom_id) REFERENCES classrooms(id) ON DELETE CASCADE,
  FOREIGN KEY (teacher_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS announcements (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  classroom_id  INTEGER NOT NULL,
  teacher_id    INTEGER NOT NULL,
  message       TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (classroom_id) REFERENCES classrooms(id) ON DELETE CASCADE,
  FOREIGN KEY (teacher_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_announcements_classroom ON announcements(classroom_id, created_at DESC);

CREATE TABLE IF NOT EXISTS submissions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id  INTEGER NOT NULL,
  student_id     INTEGER NOT NULL,
  answers        TEXT NOT NULL,          -- JSON array, index-aligned with the assignment's questions
  status         TEXT NOT NULL DEFAULT 'submitted', -- 'submitted' (awaiting grade) | 'graded'
  score          REAL,
  max_score      REAL,
  submitted_at   INTEGER NOT NULL,
  graded_at      INTEGER,
  graded_by      TEXT,                   -- 'auto' for MCQ tests, or the grading teacher's phone
  UNIQUE (assignment_id, student_id),
  FOREIGN KEY (assignment_id) REFERENCES assignments(id) ON DELETE CASCADE,
  FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_submissions_student ON submissions(student_id);
CREATE INDEX IF NOT EXISTS idx_assignments_classroom ON assignments(classroom_id);

CREATE TABLE IF NOT EXISTS app_state (
  user_id     INTEGER NOT NULL,
  key         TEXT NOT NULL,       -- e.g. 'institution','paper_patterns','question_bank',
                                    -- 'saved_papers','custom_classes','custom_chapters',
                                    -- 'custom_qtypes','deleted_builtins'
  value       TEXT NOT NULL,       -- JSON blob, exact shape the app already uses in memory
  version     INTEGER NOT NULL DEFAULT 1,
  updated_at  INTEGER NOT NULL,    -- epoch ms, authoritative server clock
  updated_by  TEXT,                -- device id that made the write
  PRIMARY KEY (user_id, key),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Rolling version history per account+slice (for recovery / "never lose
-- data" even if a bad write happens). Capped at MAX_HISTORY per key by
-- the application layer.
CREATE TABLE IF NOT EXISTS state_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,
  version     INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_history_user_key ON state_history(user_id, key, updated_at DESC);

-- Registry of devices/browsers that have connected. Not used for auth —
-- used only to label who made a change, for the "updated on Laptop 2
-- min ago" style UI and for excluding the sender from realtime
-- broadcasts.
CREATE TABLE IF NOT EXISTS devices (
  device_id   TEXT PRIMARY KEY,
  user_id     INTEGER,
  label       TEXT,
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

