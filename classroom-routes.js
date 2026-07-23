// routes/classroom.js
// -----------------------------------------------------------------------
// Classroom Layer — Google-Classroom-style workflow on top of the
// existing per-account data model:
//
//   Teacher creates a classroom -> adds students by phone -> posts
//   assignments (free-text, teacher-graded later) or MCQ tests
//   (auto-graded the instant a student submits) -> students see
//   pending/completed work and their marks; teachers see the same
//   marks recorded on their side too.
//
// Question/answer shapes:
//   mcq_test  questions: [{ q, opts:[a,b,c,d], correctIndex, marks }]
//   assignment questions: [{ q, marks }]
//   mcq_test  answers:    [{ selectedIndex }]  (index-aligned with questions)
//   assignment answers:   [{ text }]
//
// Students are NEVER sent correctIndex before they submit — only the
// grading result (right after auto-grading, or after a teacher grades
// a text assignment) includes what was correct, for review.
//
// Admin oversight: every teacher-facing route resolves an "effective
// teacher id" via effectiveTeacherId() — normally just req.user.id, but
// if the caller is an admin AND passes ?asTeacher=<id> (or {asTeacher}
// in the body), that teacher's classrooms are used instead. This is
// what makes the "Manage in app" admin feature also work for the
// Classroom tab, not just the question bank/papers.
// -----------------------------------------------------------------------
const express = require('express');
const db = require('./database');
const auth = require('./auth-lib');

function buildClassroomRouter({ broadcast }) {
  const router = express.Router();

  function stripAnswerKey(questions) {
    return (questions || []).map((q) => {
      const { correctIndex, ...rest } = q;
      return rest;
    });
  }

  // Resolves which teacher's data a request should operate on. Only an
  // admin can act as someone else, and only if that id is a real
  // teacher account — otherwise silently falls back to the caller's
  // own id (never lets a non-admin peek at another account this way).
  function effectiveTeacherId(req) {
    const asTeacher = (req.query && req.query.asTeacher) || (req.body && req.body.asTeacher);
    if (req.user.role === 'admin' && asTeacher) {
      const target = db.findUserById(Number(asTeacher));
      if (target && (target.role === 'teacher' || target.role === 'admin')) return target.id;
    }
    return req.user.id;
  }

  // ── Teacher (or admin acting as one): classrooms ─────────────────
  router.post('/classrooms', auth.requireTeacher, (req, res) => {
    const name = (req.body && req.body.name || '').trim();
    if (!name) return res.status(400).json({ ok: false, error: 'missing_name' });
    const classroom = db.createClassroom(effectiveTeacherId(req), name);
    res.json({ ok: true, classroom });
  });

  router.get('/classrooms', auth.requireTeacher, (req, res) => {
    res.json({ ok: true, classrooms: db.listClassroomsForTeacher(effectiveTeacherId(req)) });
  });

  router.delete('/classrooms/:id', auth.requireTeacher, (req, res) => {
    const classroom = db.getClassroom(Number(req.params.id));
    if (!classroom || classroom.teacher_id !== effectiveTeacherId(req)) return res.status(404).json({ ok: false, error: 'not_found' });
    db.deleteClassroom(classroom.id);
    res.json({ ok: true });
  });

  // ── Teacher: roster ──────────────────────────────────────────────
  router.get('/search-students', auth.requireTeacher, (req, res) => {
    const q = String(req.query.phone || '');
    if (q.length < 3) return res.json({ ok: true, students: [] });
    res.json({ ok: true, students: db.searchStudentsByPhone(q) });
  });

  router.get('/classrooms/:id/roster', auth.requireTeacher, (req, res) => {
    const classroom = db.getClassroom(Number(req.params.id));
    if (!classroom || classroom.teacher_id !== effectiveTeacherId(req)) return res.status(404).json({ ok: false, error: 'not_found' });
    res.json({ ok: true, roster: db.getClassroomRoster(classroom.id) });
  });

  router.post('/classrooms/:id/roster', auth.requireTeacher, (req, res) => {
    const classroom = db.getClassroom(Number(req.params.id));
    if (!classroom || classroom.teacher_id !== effectiveTeacherId(req)) return res.status(404).json({ ok: false, error: 'not_found' });
    const student = db.findUserByPhone(req.body && req.body.phone);
    if (!student || student.role !== 'student') {
      return res.status(404).json({ ok: false, error: 'student_not_found', message: 'No student account found with that phone number.' });
    }
    if (student.status !== 'active') {
      return res.status(400).json({ ok: false, error: 'student_not_active', message: 'That student account is still pending admin approval.' });
    }
    db.addStudentToClassroom(classroom.id, student.id);
    res.json({ ok: true, roster: db.getClassroomRoster(classroom.id) });
  });

  router.delete('/classrooms/:id/roster/:studentId', auth.requireTeacher, (req, res) => {
    const classroom = db.getClassroom(Number(req.params.id));
    if (!classroom || classroom.teacher_id !== effectiveTeacherId(req)) return res.status(404).json({ ok: false, error: 'not_found' });
    db.removeStudentFromClassroom(classroom.id, Number(req.params.studentId));
    res.json({ ok: true });
  });

  // ── Student: my classrooms ──────────────────────────────────────
  router.get('/my-classrooms', auth.requireStudent, (req, res) => {
    res.json({ ok: true, classrooms: db.listClassroomsForStudent(req.user.id) });
  });

  // Read-only view of a teacher's question bank / saved papers, for a
  // student who's a member of one of that teacher's classrooms.
  router.get('/teacher-content/:classroomId/:key', auth.requireStudent, (req, res) => {
    const classroom = db.getClassroom(Number(req.params.classroomId));
    if (!classroom) return res.status(404).json({ ok: false, error: 'not_found' });
    if (!db.isStudentInClassroom(classroom.id, req.user.id)) return res.status(403).json({ ok: false, error: 'not_a_member' });
    const teacher = db.findUserById(classroom.teacher_id);
    if (!teacher || teacher.status !== 'active') {
      return res.status(403).json({ ok: false, error: 'teacher_restricted', message: 'This teacher\'s account is currently restricted.' });
    }
    const key = req.params.key;
    if (key !== 'question_bank' && key !== 'saved_papers') return res.status(400).json({ ok: false, error: 'invalid_key' });
    const slice = db.readSlice(classroom.teacher_id, key);
    res.json({ ok: true, slice: slice || { value: key === 'saved_papers' ? [] : {}, updatedAt: null, version: 0 } });
  });

  // ── Assignments — visible to the owning teacher OR a member student ──
  function classroomAccessCheck(req, classroom) {
    if (!classroom) return false;
    if (req.user.role === 'teacher' && classroom.teacher_id === effectiveTeacherId(req)) return true;
    if (req.user.role === 'admin' && classroom.teacher_id === effectiveTeacherId(req)) return true;
    if (req.user.role === 'student' && db.isStudentInClassroom(classroom.id, req.user.id)) return true;
    return false;
  }

  router.post('/classrooms/:id/assignments', auth.requireTeacher, (req, res) => {
    const classroom = db.getClassroom(Number(req.params.id));
    if (!classroom || classroom.teacher_id !== effectiveTeacherId(req)) return res.status(404).json({ ok: false, error: 'not_found' });
    const { type, title, instructions, questions, dueAt, timeLimitMinutes } = req.body || {};
    if (type !== 'assignment' && type !== 'mcq_test') return res.status(400).json({ ok: false, error: 'invalid_type' });
    if (!title || !Array.isArray(questions) || !questions.length) return res.status(400).json({ ok: false, error: 'missing_fields' });
    const assignment = db.createAssignment(classroom.id, effectiveTeacherId(req), type, title, instructions, questions, dueAt, type === 'mcq_test' ? timeLimitMinutes : null);
    res.json({ ok: true, assignment });
  });

  router.get('/classrooms/:id/assignments', auth.requireAuth, (req, res) => {
    const classroom = db.getClassroom(Number(req.params.id));
    if (!classroomAccessCheck(req, classroom)) return res.status(403).json({ ok: false, error: 'forbidden' });
    let assignments = db.listAssignmentsForClassroom(classroom.id);
    if (req.user.role === 'student') {
      // Never send the answer key to students; also attach their own
      // submission (if any) so the frontend can show pending/completed.
      assignments = assignments.map((a) => {
        const sub = db.getSubmission(a.id, req.user.id);
        return { ...a, questions: a.type === 'mcq_test' ? stripAnswerKey(a.questions) : a.questions, mySubmission: sub || null };
      });
    }
    res.json({ ok: true, assignments });
  });

  router.delete('/assignments/:id', auth.requireTeacher, (req, res) => {
    const assignment = db.getAssignment(Number(req.params.id));
    if (!assignment || assignment.teacher_id !== effectiveTeacherId(req)) return res.status(404).json({ ok: false, error: 'not_found' });
    db.deleteAssignment(assignment.id);
    res.json({ ok: true });
  });

  // ── Announcements — lightweight classroom-wide notes, separate from
  // graded work (e.g. "No class Friday", "Bring calculators tomorrow") ──
  router.post('/classrooms/:id/announcements', auth.requireTeacher, (req, res) => {
    const classroom = db.getClassroom(Number(req.params.id));
    if (!classroom || classroom.teacher_id !== effectiveTeacherId(req)) return res.status(404).json({ ok: false, error: 'not_found' });
    const message = (req.body && req.body.message || '').trim();
    if (!message) return res.status(400).json({ ok: false, error: 'missing_message' });
    const announcement = db.createAnnouncement(classroom.id, effectiveTeacherId(req), message);
    broadcast(classroom.teacher_id, { type: 'announcement', classroomId: classroom.id }, null);
    res.json({ ok: true, announcement });
  });

  router.get('/classrooms/:id/announcements', auth.requireAuth, (req, res) => {
    const classroom = db.getClassroom(Number(req.params.id));
    if (!classroomAccessCheck(req, classroom)) return res.status(403).json({ ok: false, error: 'forbidden' });
    res.json({ ok: true, announcements: db.listAnnouncementsForClassroom(classroom.id) });
  });

  router.delete('/announcements/:id', auth.requireTeacher, (req, res) => {
    const announcement = db.getAnnouncement(Number(req.params.id));
    if (!announcement || announcement.teacher_id !== effectiveTeacherId(req)) return res.status(404).json({ ok: false, error: 'not_found' });
    db.deleteAnnouncement(announcement.id);
    res.json({ ok: true });
  });

  // ── Submissions ──────────────────────────────────────────────────
  router.post('/assignments/:id/submit', auth.requireStudent, (req, res) => {
    const assignment = db.getAssignment(Number(req.params.id));
    if (!assignment) return res.status(404).json({ ok: false, error: 'not_found' });
    if (!db.isStudentInClassroom(assignment.classroom_id, req.user.id)) return res.status(403).json({ ok: false, error: 'forbidden' });
    const existing = db.getSubmission(assignment.id, req.user.id);
    if (existing) return res.status(409).json({ ok: false, error: 'already_submitted', message: 'You\'ve already submitted this.' });
    const answers = (req.body && req.body.answers) || [];
    if (!Array.isArray(answers)) return res.status(400).json({ ok: false, error: 'invalid_answers' });

    // Server-side time limit check — the client shows a countdown and
    // auto-submits, but that's a courtesy, not the enforcement. A
    // startedAt timestamp the client sends when the test was opened is
    // compared against the assignment's own limit, so a student can't
    // just ignore the countdown and keep answering indefinitely.
    if (assignment.type === 'mcq_test' && assignment.time_limit_minutes) {
      const startedAt = Number(req.body && req.body.startedAt) || Date.now();
      const elapsedMinutes = (Date.now() - startedAt) / 60000;
      if (elapsedMinutes > assignment.time_limit_minutes + 0.5) { // small grace period for network lag
        return res.status(400).json({ ok: false, error: 'time_expired', message: 'Time limit for this test has passed.' });
      }
    }

    if (assignment.type === 'mcq_test') {
      // Auto-grade instantly — "assessment on the spot".
      let score = 0, maxScore = 0;
      assignment.questions.forEach((q, i) => {
        const marks = Number(q.marks) || 1;
        maxScore += marks;
        const given = answers[i] && answers[i].selectedIndex;
        if (given === q.correctIndex) score += marks;
      });
      const submission = db.submitAssignment(assignment.id, req.user.id, answers, 'graded', score, maxScore, 'auto');
      // Include the answer key now, for post-submission review.
      broadcast(assignment.teacher_id, { type: 'submission', assignmentId: assignment.id, studentId: req.user.id }, null);
      return res.json({ ok: true, submission, questions: assignment.questions });
    }

    // Free-text assignment — awaits manual grading.
    const submission = db.submitAssignment(assignment.id, req.user.id, answers, 'submitted', null, null, null);
    broadcast(assignment.teacher_id, { type: 'submission', assignmentId: assignment.id, studentId: req.user.id }, null);
    res.json({ ok: true, submission });
  });

  router.get('/assignments/:id/submissions', auth.requireTeacher, (req, res) => {
    const assignment = db.getAssignment(Number(req.params.id));
    if (!assignment || assignment.teacher_id !== effectiveTeacherId(req)) return res.status(404).json({ ok: false, error: 'not_found' });
    res.json({ ok: true, assignment, submissions: db.listSubmissionsForAssignment(assignment.id) });
  });

  router.put('/submissions/:id/grade', auth.requireTeacher, (req, res) => {
    const submission = db.getSubmissionById(Number(req.params.id));
    if (!submission) return res.status(404).json({ ok: false, error: 'not_found' });
    const assignment = db.getAssignment(submission.assignment_id);
    if (!assignment || assignment.teacher_id !== effectiveTeacherId(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
    const { score, maxScore } = req.body || {};
    if (typeof score !== 'number' || typeof maxScore !== 'number') return res.status(400).json({ ok: false, error: 'invalid_score' });
    const graded = db.gradeSubmission(submission.id, score, maxScore, req.user.phone);
    broadcast(submission.student_id, { type: 'graded', assignmentId: assignment.id }, null);
    res.json({ ok: true, submission: graded });
  });

  // ── Student: everything I've submitted / still owe, across classrooms ──
  router.get('/my-submissions', auth.requireStudent, (req, res) => {
    res.json({ ok: true, submissions: db.listSubmissionsForStudent(req.user.id) });
  });

  // Aggregate view across every classroom the student belongs to, so
  // the student dashboard doesn't need to loop over classrooms itself.
  router.get('/my-assignments', auth.requireStudent, (req, res) => {
    const classrooms = db.listClassroomsForStudent(req.user.id);
    const assignments = [];
    classrooms.forEach((c) => {
      db.listAssignmentsForClassroom(c.id).forEach((a) => {
        const sub = db.getSubmission(a.id, req.user.id);
        assignments.push({
          ...a,
          questions: a.type === 'mcq_test' ? stripAnswerKey(a.questions) : a.questions,
          classroomName: c.name,
          mySubmission: sub || null,
        });
      });
    });
    res.json({ ok: true, assignments });
  });

  router.get('/my-announcements', auth.requireStudent, (req, res) => {
    const classrooms = db.listClassroomsForStudent(req.user.id);
    const announcements = [];
    classrooms.forEach((c) => {
      db.listAnnouncementsForClassroom(c.id).forEach((a) => {
        announcements.push({ ...a, classroomName: c.name });
      });
    });
    announcements.sort((a, b) => b.created_at - a.created_at);
    res.json({ ok: true, announcements });
  });

  return router;
}

module.exports = { buildClassroomRouter };
