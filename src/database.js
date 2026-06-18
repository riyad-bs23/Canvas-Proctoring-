const Database = require('better-sqlite3')
const path = require('path')
const fs = require('fs')

const dbDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data')
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true })

const db = new Database(path.join(dbDir, 'proctoring.db'))

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    course_id TEXT NOT NULL,
    quiz_id TEXT DEFAULT '',
    quiz_name TEXT DEFAULT 'Exam',
    quiz_url TEXT DEFAULT '',
    student_id TEXT NOT NULL,
    student_name TEXT NOT NULL,
    canvas_user_id TEXT DEFAULT '',
    status TEXT DEFAULT 'active',
    flag_count INTEGER DEFAULT 0,
    review_status TEXT DEFAULT 'pending',
    id_verified INTEGER DEFAULT 0,
    started_at TEXT DEFAULT (datetime('now')),
    ended_at TEXT
  );

  CREATE TABLE IF NOT EXISTS captures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    course_id TEXT NOT NULL,
    student_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    flag_reason TEXT DEFAULT '',
    is_flagged INTEGER DEFAULT 0,
    capture_type TEXT DEFAULT 'scheduled',
    captured_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    course_id TEXT NOT NULL,
    student_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    detail TEXT DEFAULT '',
    severity TEXT DEFAULT 'low',
    occurred_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS proctor_tokens (
    token TEXT PRIMARY KEY,
    student_id TEXT NOT NULL,
    course_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    quiz_url TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    used INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS instructor_tokens (
    token TEXT PRIMARY KEY,
    course_id TEXT NOT NULL,
    course_name TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );
`)

// Migrations for existing databases
try { db.exec(`ALTER TABLE sessions ADD COLUMN canvas_user_id TEXT DEFAULT ''`) } catch (e) {}

// ── Sessions ──────────────────────────────────────────────────────────────────

function createSession(id, courseId, quizId, quizName, quizUrl, studentId, studentName, canvasUserId) {
  db.prepare(`
    INSERT OR REPLACE INTO sessions
      (id, course_id, quiz_id, quiz_name, quiz_url, student_id, student_name, canvas_user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, courseId, quizId || '', quizName || 'Exam', quizUrl || '',
    studentId, studentName, canvasUserId || studentId)
  return db.prepare(`SELECT * FROM sessions WHERE id=?`).get(id)
}

function getSession(id) {
  return db.prepare(`SELECT * FROM sessions WHERE id=?`).get(id)
}

function endSession(id) {
  db.prepare(`UPDATE sessions SET status='completed', ended_at=datetime('now') WHERE id=?`).run(id)
}

function getAllSessions(courseId) {
  return db.prepare(`SELECT * FROM sessions WHERE course_id=? ORDER BY started_at DESC`).all(courseId)
}

function updateReview(sessionId, status) {
  db.prepare(`UPDATE sessions SET review_status=? WHERE id=?`).run(status, sessionId)
}

function getActiveSession(studentId, courseId) {
  return db.prepare(`
    SELECT * FROM sessions WHERE student_id=? AND course_id=? AND status='active'
  `).get(studentId, courseId)
}

function markIdVerified(sessionId) {
  db.prepare(`UPDATE sessions SET id_verified=1 WHERE id=?`).run(sessionId)
}

// Mark sessions older than N hours as abandoned (handles crashed browsers)
function expireOldSessions(hoursOld = 6) {
  const result = db.prepare(`
    UPDATE sessions SET status='abandoned', ended_at=datetime('now')
    WHERE status='active' AND started_at < datetime('now', '-' || ? || ' hours')
  `).run(hoursOld)
  return result.changes
}

// ── Captures ──────────────────────────────────────────────────────────────────

function saveCapture(sessionId, courseId, studentId, filename, flagReason, isFlagged, captureType) {
  db.prepare(`
    INSERT INTO captures
      (session_id, course_id, student_id, filename, flag_reason, is_flagged, capture_type)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(sessionId, courseId, studentId, filename, flagReason || '', isFlagged ? 1 : 0, captureType || 'scheduled')
  // flag_count is only incremented by logEvent (severity='high') — NOT here.
  // Every flagged capture is always accompanied by a prior high-severity event,
  // so incrementing here would double-count flags.
}

function getCaptures(sessionId) {
  return db.prepare(`SELECT * FROM captures WHERE session_id=? ORDER BY captured_at ASC`).all(sessionId)
}

function getFlaggedCaptures(courseId) {
  return db.prepare(`
    SELECT c.*, s.student_name FROM captures c
    JOIN sessions s ON c.session_id=s.id
    WHERE c.course_id=? AND c.is_flagged=1 ORDER BY c.captured_at DESC
  `).all(courseId)
}

// ── Events ────────────────────────────────────────────────────────────────────

function logEvent(sessionId, courseId, studentId, type, detail, severity) {
  db.prepare(`
    INSERT INTO events (session_id, course_id, student_id, event_type, detail, severity)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(sessionId, courseId, studentId, type, detail || '', severity || 'low')
  if (severity === 'high') {
    db.prepare(`UPDATE sessions SET flag_count=flag_count+1 WHERE id=?`).run(sessionId)
  }
}

function getEvents(sessionId) {
  return db.prepare(`SELECT * FROM events WHERE session_id=? ORDER BY occurred_at ASC`).all(sessionId)
}

function getRecentEvents(courseId, limit) {
  return db.prepare(`
    SELECT e.*, s.student_name FROM events e
    JOIN sessions s ON e.session_id=s.id
    WHERE e.course_id=? AND e.event_type != 'heartbeat'
    ORDER BY e.occurred_at DESC LIMIT ?
  `).all(courseId, limit || 20)
}

// ── Stats ─────────────────────────────────────────────────────────────────────

function getCourseStats(courseId) {
  const total   = db.prepare(`SELECT COUNT(*) as n FROM sessions WHERE course_id=?`).get(courseId).n
  const flagged = db.prepare(`SELECT COUNT(*) as n FROM sessions WHERE course_id=? AND flag_count>0`).get(courseId).n
  const pending = db.prepare(`SELECT COUNT(*) as n FROM sessions WHERE course_id=? AND review_status='pending'`).get(courseId).n
  const active  = db.prepare(`SELECT COUNT(*) as n FROM sessions WHERE course_id=? AND status='active'`).get(courseId).n
  const captures = db.prepare(`SELECT COUNT(*) as n FROM captures WHERE course_id=?`).get(courseId).n
  return { total, flagged, clean: total - flagged, pending, active, captures }
}

// ── Proctor tokens ────────────────────────────────────────────────────────────

function createProctorToken(token, studentId, courseId, sessionId, quizUrl) {
  db.prepare(`
    INSERT INTO proctor_tokens (token, student_id, course_id, session_id, quiz_url)
    VALUES (?, ?, ?, ?, ?)
  `).run(token, studentId, courseId, sessionId, quizUrl)
}

function getProctorToken(token) {
  return db.prepare(`SELECT * FROM proctor_tokens WHERE token=? AND used=0`).get(token)
}

function markTokenUsed(token) {
  db.prepare(`UPDATE proctor_tokens SET used=1 WHERE token=?`).run(token)
}

// ── Instructor tokens ─────────────────────────────────────────────────────────

function createInstructorToken(token, courseId, courseName) {
  db.prepare(`
    INSERT INTO instructor_tokens (token, course_id, course_name, expires_at)
    VALUES (?, ?, ?, datetime('now', '+24 hours'))
  `).run(token, courseId, courseName || '')
}

function getInstructorToken(token) {
  return db.prepare(`
    SELECT * FROM instructor_tokens
    WHERE token=? AND expires_at > datetime('now')
  `).get(token)
}

function cleanupExpiredInstructorTokens() {
  db.prepare(`DELETE FROM instructor_tokens WHERE expires_at <= datetime('now')`).run()
}

module.exports = {
  createSession, getSession, endSession, getAllSessions, updateReview,
  getActiveSession, markIdVerified, expireOldSessions,
  saveCapture, getCaptures, getFlaggedCaptures,
  logEvent, getEvents, getRecentEvents,
  getCourseStats,
  createProctorToken, getProctorToken, markTokenUsed,
  createInstructorToken, getInstructorToken, cleanupExpiredInstructorTokens
}
