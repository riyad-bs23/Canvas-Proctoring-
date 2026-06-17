require('dotenv').config()
const express = require('express')
const bodyParser = require('body-parser')
const path = require('path')
const fs = require('fs')
const { v4: uuidv4 } = require('uuid')
const db = require('./database')
const { extractLTI, CONSUMER_KEY, CONSUMER_SECRET } = require('./lti')

const app = express()
const PORT = process.env.PORT || 8083
const HOST = process.env.HOST || 'http://localhost:8083'
const CAPTURE_INTERVAL = parseInt(process.env.CAPTURE_INTERVAL) || 30
const FLAG_THRESHOLD = parseInt(process.env.FLAG_THRESHOLD) || 3
const CANVAS_URL = (process.env.CANVAS_URL || 'http://localhost:3000').replace(/\/$/, '')
const CANVAS_TOKEN = process.env.CANVAS_API_TOKEN || ''

const capturesDir = path.join(__dirname, '..', 'captures')
if (!fs.existsSync(capturesDir)) fs.mkdirSync(capturesDir, { recursive: true })

app.use(bodyParser.urlencoded({ extended: true }))
app.use(bodyParser.json({ limit: '5mb' }))
app.set('view engine', 'ejs')
app.set('views', path.join(__dirname, '..', 'views'))
app.use('/captures', express.static(capturesDir))

// ── Canvas API helper ─────────────────────────────────────────────────────────
async function fetchCanvasQuizzes(courseId) {
  if (!CANVAS_TOKEN || !courseId) return []
  const https = CANVAS_URL.startsWith('https') ? require('https') : require('http')
  const url = `${CANVAS_URL}/api/v1/courses/${courseId}/quizzes?per_page=50&published=true`
  return new Promise((resolve) => {
    const options = {
      headers: { Authorization: `Bearer ${CANVAS_TOKEN}` }
    }
    const req = (CANVAS_URL.startsWith('https') ? require('https') : require('http')).get(url, options, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch { resolve([]) }
      })
    })
    req.on('error', () => resolve([]))
    req.setTimeout(5000, () => { req.destroy(); resolve([]) })
  })
}

// ── LTI Launch ───────────────────────────────────────────────────────────────
app.post('/launch', async (req, res) => {
  try {
    if (!req.body.lti_message_type) return res.status(400).send('Not a valid LTI launch')
    const lti = extractLTI(req.body)

    if (lti.isInstructor) {
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

    // Check for existing active session
    const existing = db.getActiveSession(lti.userId, lti.courseId)
    if (existing) {
      // Resume existing session rather than creating a duplicate
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

    // Fetch published quizzes from Canvas API
    const quizzes = await fetchCanvasQuizzes(lti.courseId)

    // Student — show pre-exam checklist with quiz picker
    return res.render('pre_exam', {
      studentId: lti.userId,
      studentName: lti.name,
      courseId: lti.courseId,
      quizzes: quizzes || [],
      captureInterval: CAPTURE_INTERVAL,
      HOST,
      CANVAS_URL
    })
  } catch (err) {
    console.error('Launch error:', err)
    res.status(500).send(`<pre>Error: ${err.message}</pre>`)
  }
})

// ── API: Fetch quizzes (called by frontend if needed) ─────────────────────────
app.get('/api/quizzes/:courseId', async (req, res) => {
  try {
    const quizzes = await fetchCanvasQuizzes(req.params.courseId)
    res.json({ success: true, quizzes: quizzes || [] })
  } catch (err) {
    res.json({ success: false, quizzes: [] })
  }
})

// ── Student: Start proctoring session ────────────────────────────────────────
app.post('/start-session', (req, res) => {
  try {
    const { studentId, studentName, courseId, quizId, quizName, quizUrl } = req.body

    // Prevent duplicate active sessions
    const existing = db.getActiveSession(studentId, courseId)
    if (existing) {
      return res.render('student', {
        sessionId: existing.id,
        courseId,
        studentId,
        studentName,
        quizName: existing.quiz_name,
        quizUrl: existing.quiz_url,
        quizId: existing.quiz_id,
        captureInterval: CAPTURE_INTERVAL,
        flagThreshold: FLAG_THRESHOLD,
        resumed: true,
        HOST
      })
    }

    const sessionId = uuidv4()
    db.createSession(sessionId, courseId, quizId, quizName, quizUrl, studentId, studentName)

    return res.render('student', {
      sessionId,
      courseId,
      studentId,
      studentName,
      quizName,
      quizUrl,
      quizId,
      captureInterval: CAPTURE_INTERVAL,
      flagThreshold: FLAG_THRESHOLD,
      resumed: false,
      HOST
    })
  } catch (err) {
    res.status(500).send(`<pre>Error: ${err.message}</pre>`)
  }
})

// ── API: Save capture ─────────────────────────────────────────────────────────
app.post('/api/capture', (req, res) => {
  try {
    const { sessionId, courseId, studentId, imageData, flagReason, isFlagged, captureType } = req.body
    if (!sessionId || !imageData) return res.json({ success: false })

    const base64 = imageData.replace(/^data:image\/\w+;base64,/, '')
    const filename = `${sessionId}_${Date.now()}.png`
    fs.writeFileSync(path.join(capturesDir, filename), base64, 'base64')

    db.saveCapture(sessionId, courseId, studentId, filename, flagReason || '', isFlagged || false, captureType || 'scheduled')
    const session = db.getSession(sessionId)

    return res.json({
      success: true,
      flagCount: session?.flag_count || 0,
      exceeded: (session?.flag_count || 0) >= FLAG_THRESHOLD
    })
  } catch (err) {
    res.json({ success: false, error: err.message })
  }
})

// ── API: Log event ────────────────────────────────────────────────────────────
app.post('/api/event', (req, res) => {
  try {
    const { sessionId, courseId, studentId, eventType, detail, severity } = req.body
    db.logEvent(sessionId, courseId, studentId, eventType, detail, severity)
    const session = db.getSession(sessionId)
    res.json({ success: true, flagCount: session?.flag_count || 0 })
  } catch (err) {
    res.json({ success: false })
  }
})

// ── API: Mark ID verified ─────────────────────────────────────────────────────
app.post('/api/id-verified', (req, res) => {
  try {
    const { sessionId } = req.body
    db.markIdVerified(sessionId)
    res.json({ success: true })
  } catch (err) {
    res.json({ success: false })
  }
})

// ── API: End session + generate token ────────────────────────────────────────
app.post('/api/end-session', (req, res) => {
  try {
    const { sessionId, courseId, studentId, quizUrl } = req.body
    db.endSession(sessionId)

    const token = uuidv4()
    db.createProctorToken(token, studentId, courseId, sessionId, quizUrl || '')

    res.json({ success: true, token, quizUrl })
  } catch (err) {
    res.json({ success: false })
  }
})

// ── Token verification page ───────────────────────────────────────────────────
app.get('/proceed/:token', (req, res) => {
  try {
    const record = db.getProctorToken(req.params.token)
    if (!record) {
      return res.send(`
        <div style="font-family:sans-serif;padding:40px;background:#080c18;color:#f87171;min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;">
          <div>
            <h2>❌ Invalid or Expired Token</h2>
            <p style="color:#6b7fa3;margin-top:12px;">You must complete proctoring before accessing the quiz.</p>
          </div>
        </div>
      `)
    }
    db.markTokenUsed(req.params.token)
    return res.render('proceed', { quizUrl: record.quiz_url, sessionId: record.session_id })
  } catch (err) {
    res.status(500).send(err.message)
  }
})

// ── Instructor: session detail ────────────────────────────────────────────────
app.get('/session/:sessionId', (req, res) => {
  try {
    const session = db.getSession(req.params.sessionId)
    if (!session) return res.status(404).send('Not found')
    const captures = db.getCaptures(req.params.sessionId)
    const events = db.getEvents(req.params.sessionId)
    res.render('session_detail', { session, captures, events, HOST })
  } catch (err) {
    res.status(500).send(err.message)
  }
})

// ── Instructor: update review status ─────────────────────────────────────────
app.post('/session/:sessionId/review', (req, res) => {
  const { status, courseId, courseName } = req.body
  db.updateReview(req.params.sessionId, status)
  const sessions = db.getAllSessions(courseId)
  const stats = db.getCourseStats(courseId)
  const flagged = db.getFlaggedCaptures(courseId)
  const recentEvents = db.getRecentEvents(courseId, 20)
  res.render('instructor', {
    sessions, stats, flagged, recentEvents,
    courseId, courseName: courseName || 'Course',
    HOST, flash: { type: 'success', message: `Session marked as ${status}` }
  })
})

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.send(`
    <html><body style="font-family:sans-serif;padding:30px;background:#080c18;color:#e8eaf6;">
      <h2>🔒 Canvas Proctoring Plugin</h2>
      <p>Status: <strong style="color:#43e97b">Running on port ${PORT}</strong></p>
      <hr style="border-color:#1e2a4a;margin:20px 0">
      <table style="font-size:14px;border-collapse:collapse;">
        <tr><td style="padding:6px 16px 6px 0;color:#8b92b8">Launch URL</td><td><strong>${HOST}/launch</strong></td></tr>
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
  console.log(`🚀 Launch: ${HOST}/launch`)
  console.log(`🔑 Key: ${CONSUMER_KEY} | Secret: ${CONSUMER_SECRET}\n`)
})
