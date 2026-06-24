require('dotenv').config()
const express = require('express')
const bodyParser = require('body-parser')
const path = require('path')
const fs = require('fs')
const { v4: uuidv4 } = require('uuid')
const db = require('./database')
const { extractLTI, verifyLTISignature, CONSUMER_KEY, CONSUMER_SECRET } = require('./lti')

const app = express()
const PORT = process.env.PORT || 8083
const HOST = (process.env.HOST || 'http://localhost:8083').replace(/\/$/, '')
const LAUNCH_URL = process.env.LAUNCH_URL || `${HOST}/launch`
const CAPTURE_INTERVAL = parseInt(process.env.CAPTURE_INTERVAL) || 30
const FLAG_THRESHOLD = parseInt(process.env.FLAG_THRESHOLD) || 3
const CANVAS_URL = (process.env.CANVAS_URL || 'http://localhost:3000').replace(/\/$/, '')
const CANVAS_TOKEN = process.env.CANVAS_API_TOKEN || ''

const capturesDir = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'captures')
  : path.join(__dirname, '..', 'captures')
if (!fs.existsSync(capturesDir)) fs.mkdirSync(capturesDir, { recursive: true })

app.use(bodyParser.urlencoded({ extended: true }))
app.use(bodyParser.json({ limit: '5mb' }))
app.set('view engine', 'ejs')
app.set('views', path.join(__dirname, '..', 'views'))

// ── CORS for Canvas custom JS (localhost only) ────────────────────────────────
app.use((req, res, next) => {
  const origin = req.headers.origin || ''
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

// ── Security headers ──────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'ALLOWALL') // required for LTI iframe embedding
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  next()
})

// ── Static files (face-api.js, model weights) ─────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'public')))

// ── Helpers ───────────────────────────────────────────────────────────────────
function parseCookies(req) {
  const cookies = {}
  ;(req.headers.cookie || '').split(';').forEach(part => {
    const idx = part.indexOf('=')
    if (idx < 0) return
    cookies[part.slice(0, idx).trim()] = part.slice(idx + 1).trim()
  })
  return cookies
}

function sendError(res, status, msg) {
  return res.status(status).send(`
    <div style="font-family:sans-serif;padding:40px;background:#080c18;color:#f87171;
      min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;">
      <div>
        <h2>Error ${status}</h2>
        <p style="color:#6b7fa3;margin-top:12px;">${msg}</p>
      </div>
    </div>
  `)
}

function sanitize(str, maxLen = 300) {
  return String(str || '').trim().slice(0, maxLen)
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ── Instructor auth middleware ─────────────────────────────────────────────────
function requireInstructor(req, res, next) {
  const token = parseCookies(req).teach_token
  if (!token) return sendError(res, 403, 'Access denied. Please launch this tool from Canvas.')
  const record = db.getInstructorToken(token)
  if (!record) return sendError(res, 403, 'Your session has expired. Please re-launch from Canvas.')
  req.teachCourseId = record.course_id
  req.teachCourseName = record.course_name
  next()
}

// ── Rate limiting for /api/capture ───────────────────────────────────────────
const captureRateMap = new Map()
setInterval(() => captureRateMap.clear(), 60000)

function captureRateLimit(req, res, next) {
  const key = req.body.sessionId || req.ip
  const count = (captureRateMap.get(key) || 0) + 1
  captureRateMap.set(key, count)
  if (count > 15) return res.status(429).json({ success: false, error: 'rate_limited' })
  next()
}

// ── Canvas API helper ─────────────────────────────────────────────────────────
async function fetchCanvasQuizzes(courseId) {
  if (!CANVAS_TOKEN || !courseId) return []
  const url = `${CANVAS_URL}/api/v1/courses/${courseId}/quizzes?per_page=50&published=true`
  const httpModule = CANVAS_URL.startsWith('https') ? require('https') : require('http')
  return new Promise((resolve) => {
    const r = httpModule.get(url, { headers: { Authorization: `Bearer ${CANVAS_TOKEN}` } }, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => { try { resolve(JSON.parse(data)) } catch { resolve([]) } })
    })
    r.on('error', () => resolve([]))
    r.setTimeout(5000, () => { r.destroy(); resolve([]) })
  })
}

async function fetchCanvasSubmissions(courseId, quizId) {
  if (!CANVAS_TOKEN || !courseId || !quizId) return []
  const url = `${CANVAS_URL}/api/v1/courses/${courseId}/quizzes/${quizId}/submissions?per_page=100`
  const httpModule = CANVAS_URL.startsWith('https') ? require('https') : require('http')
  return new Promise((resolve) => {
    const r = httpModule.get(url, { headers: { Authorization: `Bearer ${CANVAS_TOKEN}` } }, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data)
          resolve(Array.isArray(parsed) ? parsed : (parsed.quiz_submissions || []))
        } catch { resolve([]) }
      })
    })
    r.on('error', () => resolve([]))
    r.setTimeout(5000, () => { r.destroy(); resolve([]) })
  })
}

// ── Protected capture image serving ──────────────────────────────────────────
app.get('/captures/:filename', (req, res) => {
  const token = parseCookies(req).teach_token
  if (!token || !db.getInstructorToken(token)) return res.status(403).send('Access denied')
  const filename = path.basename(req.params.filename) // prevent path traversal
  const filepath = path.join(capturesDir, filename)
  if (!fs.existsSync(filepath)) return res.status(404).send('Not found')
  res.sendFile(filepath)
})

// ── LTI Launch ───────────────────────────────────────────────────────────────
app.post('/launch', async (req, res) => {
  try {
    if (!req.body.lti_message_type) return sendError(res, 400, 'Not a valid LTI launch.')

    if (!verifyLTISignature(req.body, LAUNCH_URL)) {
      console.warn('LTI signature verification failed from IP:', req.ip)
      return sendError(res, 401, 'LTI signature verification failed. Check your consumer key and secret.')
    }

    const lti = extractLTI(req.body)
    if (!lti.courseId) return sendError(res, 400, 'Missing course context in LTI launch.')

    if (lti.isInstructor) {
      const token = uuidv4()
      db.createInstructorToken(token, lti.courseId, lti.courseName)

      const isHttps = HOST.startsWith('https')
      res.setHeader('Set-Cookie',
        `teach_token=${token}; HttpOnly; Path=/; Max-Age=86400` +
        (isHttps ? '; SameSite=None; Secure' : '; SameSite=Lax')
      )

      const sessions = db.getAllSessions(lti.courseId)
      const stats = db.getCourseStats(lti.courseId)
      const flagged = db.getFlaggedCaptures(lti.courseId)
      const recentEvents = db.getRecentEvents(lti.courseId, 20)
      return res.render('instructor', {
        sessions, stats, flagged, recentEvents,
        courseId: lti.courseId, courseName: lti.courseName,
        HOST, flash: null
      })
    }

    // Student — check for existing active session
    const existing = db.getActiveSession(lti.userId, lti.courseId)
    if (existing) {
      return res.render('student', {
        sessionId: existing.id,
        courseId: existing.course_id,
        studentId: lti.userId,
        studentName: lti.name,
        quizName: existing.quiz_name,
        quizUrl: existing.quiz_url,
        quizId: existing.quiz_id,
        captureInterval: CAPTURE_INTERVAL,
        flagThreshold: FLAG_THRESHOLD,
        resumed: true,
        HOST
      })
    }

    const quizzes = await fetchCanvasQuizzes(lti.courseId)
    return res.render('pre_exam', {
      studentId: lti.userId,
      canvasUserId: lti.canvasUserId,
      studentName: lti.name,
      courseId: lti.courseId,
      quizzes: quizzes || [],
      captureInterval: CAPTURE_INTERVAL,
      HOST,
      CANVAS_URL
    })
  } catch (err) {
    console.error('Launch error:', err)
    return sendError(res, 500, 'An error occurred during launch. Please try again.')
  }
})

// ── Student: Start session ────────────────────────────────────────────────────
app.post('/start-session', (req, res) => {
  try {
    const studentId   = sanitize(req.body.studentId, 100)
    const studentName = sanitize(req.body.studentName, 200)
    const courseId    = sanitize(req.body.courseId, 100)
    const quizId      = sanitize(req.body.quizId, 100)
    const quizName    = sanitize(req.body.quizName, 300)
    const quizUrl     = sanitize(req.body.quizUrl, 500)
    const canvasUserId = sanitize(req.body.canvasUserId, 100)

    if (!studentId || !courseId) return sendError(res, 400, 'Missing required fields.')

    const existing = db.getActiveSession(studentId, courseId)
    if (existing) {
      return res.render('student', {
        sessionId: existing.id, courseId, studentId, studentName,
        quizName: existing.quiz_name, quizUrl: existing.quiz_url, quizId: existing.quiz_id,
        captureInterval: CAPTURE_INTERVAL, flagThreshold: FLAG_THRESHOLD, resumed: true, HOST
      })
    }

    const sessionId = uuidv4()
    db.createSession(sessionId, courseId, quizId, quizName, quizUrl, studentId, studentName, canvasUserId)

    return res.render('student', {
      sessionId, courseId, studentId, studentName, quizName, quizUrl, quizId,
      captureInterval: CAPTURE_INTERVAL, flagThreshold: FLAG_THRESHOLD, resumed: false, HOST
    })
  } catch (err) {
    console.error('Start session error:', err)
    return sendError(res, 500, 'Failed to start session. Please try again.')
  }
})

// ── API: Save capture ─────────────────────────────────────────────────────────
app.post('/api/capture', captureRateLimit, (req, res) => {
  try {
    const { sessionId, courseId, studentId, imageData, flagReason, isFlagged, captureType } = req.body
    if (!sessionId || !UUID_RE.test(sessionId)) return res.json({ success: false })
    if (!imageData || !imageData.startsWith('data:image/')) return res.json({ success: false })

    const session = db.getSession(sessionId)
    if (!session || session.status !== 'active') return res.json({ success: false })

    const base64 = imageData.replace(/^data:image\/\w+;base64,/, '')
    const filename = `${sessionId}_${Date.now()}.png`
    fs.writeFileSync(path.join(capturesDir, filename), base64, 'base64')

    db.saveCapture(sessionId, courseId, studentId, filename,
      sanitize(flagReason, 200), isFlagged || false, captureType || 'scheduled')

    const updated = db.getSession(sessionId)
    return res.json({
      success: true,
      flagCount: updated?.flag_count || 0,
      exceeded: (updated?.flag_count || 0) >= FLAG_THRESHOLD
    })
  } catch (err) {
    console.error('Capture error:', err)
    res.json({ success: false })
  }
})

// ── API: Quiz page event (from Canvas custom JS) ──────────────────────────────
app.post('/api/quiz-event', (req, res) => {
  try {
    const { canvasUserId, courseId, eventType, detail, severity } = req.body
    if (!canvasUserId || !courseId) return res.json({ success: false })

    const session = db.getActiveSessionByCanvasUserId(String(canvasUserId), String(courseId))
    if (!session) return res.json({ success: false, reason: 'no_active_session' })

    db.logEvent(session.id, session.course_id, session.student_id,
      sanitize(eventType, 50), sanitize(detail, 500), severity || 'high')

    const updated = db.getSession(session.id)
    res.json({ success: true, flagCount: updated?.flag_count || 0 })
  } catch (err) {
    console.error('Quiz event error:', err)
    res.json({ success: false })
  }
})

// ── API: Log event ────────────────────────────────────────────────────────────
app.post('/api/event', (req, res) => {
  try {
    const { sessionId, courseId, studentId, eventType, detail, severity } = req.body
    if (!sessionId || !UUID_RE.test(sessionId)) return res.json({ success: false })

    const session = db.getSession(sessionId)
    if (!session) return res.json({ success: false })

    db.logEvent(sessionId, courseId, studentId,
      sanitize(eventType, 50), sanitize(detail, 500), severity || 'low')

    const updated = db.getSession(sessionId)
    res.json({ success: true, flagCount: updated?.flag_count || 0 })
  } catch (err) {
    res.json({ success: false })
  }
})

// ── API: Mark ID verified ─────────────────────────────────────────────────────
app.post('/api/id-verified', (req, res) => {
  try {
    const { sessionId } = req.body
    if (!sessionId || !UUID_RE.test(sessionId)) return res.json({ success: false })
    db.markIdVerified(sessionId)
    res.json({ success: true })
  } catch (err) {
    res.json({ success: false })
  }
})

// ── API: End session ──────────────────────────────────────────────────────────
app.post('/api/end-session', (req, res) => {
  try {
    const { sessionId, courseId, studentId, quizUrl } = req.body
    if (!sessionId || !UUID_RE.test(sessionId)) return res.json({ success: false })

    db.endSession(sessionId)
    const token = uuidv4()
    db.createProctorToken(token, studentId, courseId, sessionId, quizUrl || '')
    res.json({ success: true, token, quizUrl })
  } catch (err) {
    res.json({ success: false })
  }
})

// ── API: Check quiz submission ────────────────────────────────────────────────
app.get('/api/check-submission/:sessionId', async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.sessionId)) return res.json({ submitted: false })

    const session = db.getSession(req.params.sessionId)
    if (!session || session.status !== 'active') return res.json({ submitted: false })
    if (!CANVAS_TOKEN || !session.quiz_id || session.quiz_id === 'manual') {
      return res.json({ submitted: false })
    }

    const subs = await fetchCanvasSubmissions(session.course_id, session.quiz_id)
    const ids = [...new Set([
      String(session.canvas_user_id || ''),
      String(session.student_id || '')
    ])].filter(Boolean)

    const match = subs.find(s =>
      ids.includes(String(s.user_id)) &&
      (s.workflow_state === 'complete' || s.workflow_state === 'pending_review')
    )
    res.json({ submitted: !!match })
  } catch (err) {
    res.json({ submitted: false })
  }
})

// ── Token verification page ───────────────────────────────────────────────────
app.get('/proceed/:token', (req, res) => {
  try {
    const record = db.getProctorToken(req.params.token)
    if (!record) {
      return sendError(res, 403, 'Invalid or expired token. You must complete proctoring before accessing the quiz.')
    }
    db.markTokenUsed(req.params.token)
    return res.render('proceed', { quizUrl: record.quiz_url, sessionId: record.session_id })
  } catch (err) {
    console.error('Proceed error:', err)
    return sendError(res, 500, 'An error occurred. Please try again.')
  }
})

// ── Instructor: session detail ────────────────────────────────────────────────
app.get('/session/:sessionId', requireInstructor, (req, res) => {
  try {
    const session = db.getSession(req.params.sessionId)
    if (!session) return sendError(res, 404, 'Session not found.')
    if (session.course_id !== req.teachCourseId) return sendError(res, 403, 'Access denied.')
    const captures = db.getCaptures(req.params.sessionId)
    const events = db.getEvents(req.params.sessionId)
    res.render('session_detail', { session, captures, events, HOST })
  } catch (err) {
    console.error('Session detail error:', err)
    return sendError(res, 500, 'Failed to load session.')
  }
})

// ── Instructor: update review status ─────────────────────────────────────────
app.post('/session/:sessionId/review', requireInstructor, (req, res) => {
  try {
    const session = db.getSession(req.params.sessionId)
    if (!session || session.course_id !== req.teachCourseId) return sendError(res, 403, 'Access denied.')

    const { status } = req.body
    if (!['pending', 'cleared', 'suspicious'].includes(status)) return sendError(res, 400, 'Invalid status.')

    db.updateReview(req.params.sessionId, status)
    const sessions = db.getAllSessions(req.teachCourseId)
    const stats = db.getCourseStats(req.teachCourseId)
    const flagged = db.getFlaggedCaptures(req.teachCourseId)
    const recentEvents = db.getRecentEvents(req.teachCourseId, 20)
    res.render('instructor', {
      sessions, stats, flagged, recentEvents,
      courseId: req.teachCourseId, courseName: req.teachCourseName,
      HOST, flash: { type: 'success', message: `Session marked as ${status}` }
    })
  } catch (err) {
    console.error('Review error:', err)
    return sendError(res, 500, 'Failed to update review status.')
  }
})

// ── Background jobs ───────────────────────────────────────────────────────────
setInterval(() => {
  try {
    const n = db.expireOldSessions(6)
    if (n > 0) console.log(`[cleanup] Expired ${n} abandoned session(s)`)
  } catch (e) { console.error('Session cleanup error:', e) }
}, 30 * 60 * 1000)

setInterval(() => {
  try { db.cleanupExpiredInstructorTokens() } catch (e) {}
}, 6 * 60 * 60 * 1000)

// ── Canvas Custom JS (paste detection for quiz pages) ────────────────────────
app.get('/canvas-custom.js', (req, res) => {
  res.set('Content-Type', 'application/javascript')
  res.set('Access-Control-Allow-Origin', '*')
  res.send(`
(function () {
  if (!window.location.pathname.includes('/quizzes/') || !window.location.pathname.includes('/take')) return
  var PROCTOR_URL = '${HOST}'
  var courseIdMatch = window.location.pathname.match(/\\/courses\\/(\\d+)\\//)
  var courseId = courseIdMatch ? courseIdMatch[1] : null
  var canvasUserId = window.ENV && window.ENV.current_user ? String(window.ENV.current_user.id) : null
  if (!courseId || !canvasUserId) return
  function sendEvent(type, detail) {
    fetch(PROCTOR_URL + '/api/quiz-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ canvasUserId: canvasUserId, courseId: courseId, eventType: type, detail: detail, severity: 'high' })
    }).catch(function(){})
  }
  document.addEventListener('paste', function(e) {
    var txt = ''
    try { txt = e.clipboardData ? e.clipboardData.getData('text') : '' } catch(_) {}
    sendEvent('paste_in_quiz', 'Pasted in quiz (' + txt.length + ' chars): ' + txt.slice(0, 100))
  })
  document.addEventListener('copy', function() { sendEvent('copy_in_quiz', 'Copied text from quiz') })
  document.addEventListener('cut', function() { sendEvent('cut_in_quiz', 'Cut text from quiz') })
})()
  `)
})

// ── LTI Config XML (for EduAppCenter) ────────────────────────────────────────
app.get('/config.xml', (req, res) => {
  res.set('Content-Type', 'application/xml')
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<cartridge_basiclti_link xmlns="http://www.imsglobal.org/xsd/imslticc_v1p0"
  xmlns:blti="http://www.imsglobal.org/xsd/imsbasiclti_v1p0"
  xmlns:lticm="http://www.imsglobal.org/xsd/imslticm_v1p0"
  xmlns:lticp="http://www.imsglobal.org/xsd/imslticp_v1p0">
  <blti:title>Canvas Proctoring</blti:title>
  <blti:description>Webcam-based proctoring plugin for Canvas LMS. Monitors students during quizzes using face detection, audio monitoring, and tab-switch detection.</blti:description>
  <blti:launch_url>${HOST}/launch</blti:launch_url>
  <blti:extensions platform="canvas.instructure.com">
    <lticm:property name="tool_id">canvas_proctoring</lticm:property>
    <lticm:property name="privacy_level">public</lticm:property>
    <lticm:options name="course_navigation">
      <lticm:property name="url">${HOST}/launch</lticm:property>
      <lticm:property name="text">Proctoring</lticm:property>
      <lticm:property name="visibility">admins</lticm:property>
      <lticm:property name="default">disabled</lticm:property>
      <lticm:property name="enabled">true</lticm:property>
    </lticm:options>
  </blti:extensions>
  <blti:vendor>
    <lticp:code>canvas-proctoring</lticp:code>
    <lticp:name>Canvas Proctoring</lticp:name>
    <lticp:url>${HOST}</lticp:url>
  </blti:vendor>
</cartridge_basiclti_link>`)
})

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.send(`
    <html><body style="font-family:sans-serif;padding:30px;background:#080c18;color:#e8eaf6;">
      <h2>🔒 Canvas Proctoring Plugin</h2>
      <p>Status: <strong style="color:#43e97b">Running on port ${PORT}</strong></p>
      <hr style="border-color:#1e2a4a;margin:20px 0">
      <table style="font-size:14px;border-collapse:collapse;">
        <tr><td style="padding:6px 16px 6px 0;color:#8b92b8">Launch URL</td><td><strong>${LAUNCH_URL}</strong></td></tr>
        <tr><td style="padding:6px 16px 6px 0;color:#8b92b8">Consumer Key</td><td><strong>${CONSUMER_KEY}</strong></td></tr>
        <tr><td style="padding:6px 16px 6px 0;color:#8b92b8">Consumer Secret</td><td><strong>${CONSUMER_SECRET}</strong></td></tr>
        <tr><td style="padding:6px 16px 6px 0;color:#8b92b8">Canvas URL</td><td><strong>${CANVAS_URL}</strong></td></tr>
        <tr><td style="padding:6px 16px 6px 0;color:#8b92b8">Canvas Token</td><td><strong>${CANVAS_TOKEN ? '✓ Set' : '⚠️ Not set'}</strong></td></tr>
      </table>
    </body></html>
  `)
})

app.listen(PORT, () => {
  console.log(`\n🔒 Proctoring Plugin running!`)
  console.log(`📍 Health: ${HOST}`)
  console.log(`🚀 Launch: ${LAUNCH_URL}`)
  console.log(`🔑 Key: ${CONSUMER_KEY} | Secret: ${CONSUMER_SECRET}\n`)
})
