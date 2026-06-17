const crypto = require('crypto')

const CONSUMER_KEY = process.env.LTI_CONSUMER_KEY || 'proctoring-key'
const CONSUMER_SECRET = process.env.LTI_CONSUMER_SECRET || 'proctoring-secret'

// In-memory nonce store — prevents replay attacks within the 5-min window
const usedNonces = new Map()
setInterval(() => {
  const cutoff = Math.floor(Date.now() / 1000) - 300
  for (const [key, ts] of usedNonces) {
    if (ts < cutoff) usedNonces.delete(key)
  }
}, 60000)

// RFC 3986 percent-encoding used by OAuth 1.0 signature
function pct(str) {
  return encodeURIComponent(String(str ?? ''))
    .replace(/!/g, '%21').replace(/'/g, '%27')
    .replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\*/g, '%2A')
}

function verifyLTISignature(body, launchUrl) {
  if (!body.oauth_signature || !body.oauth_timestamp || !body.oauth_nonce) return false
  if (body.oauth_consumer_key !== CONSUMER_KEY) return false

  // Timestamp must be within 5 minutes of now
  const ts = parseInt(body.oauth_timestamp)
  if (isNaN(ts) || Math.abs(Math.floor(Date.now() / 1000) - ts) > 300) return false

  // Reject replayed nonces
  const nonceKey = `${body.oauth_consumer_key}:${body.oauth_nonce}`
  if (usedNonces.has(nonceKey)) return false
  usedNonces.set(nonceKey, ts)

  // Normalized parameter string — all params except oauth_signature, sorted
  const params = {}
  for (const [k, v] of Object.entries(body)) {
    if (k !== 'oauth_signature') params[k] = v
  }
  const paramStr = Object.keys(params)
    .sort()
    .map(k => `${pct(k)}=${pct(params[k])}`)
    .join('&')

  // Signature base string: METHOD & URL & params
  const baseStr = `POST&${pct(launchUrl)}&${pct(paramStr)}`

  // Signing key: consumer_secret& (token secret empty for 2-legged OAuth)
  const sigKey = `${pct(CONSUMER_SECRET)}&`
  const expected = crypto.createHmac('sha1', sigKey).update(baseStr).digest('base64')

  // Timing-safe comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'utf8'),
      Buffer.from(body.oauth_signature, 'utf8')
    )
  } catch {
    return false
  }
}

function extractLTI(body) {
  const roles = (body.roles || '').toLowerCase()
  const isInstructor = roles.includes('instructor') ||
    roles.includes('administrator') ||
    roles.includes('teachingassistant')

  return {
    userId: body.user_id || 'anon_' + Date.now(),
    canvasUserId: body.custom_canvas_user_id || body.user_id || '',
    courseId: body.custom_canvas_course_id || body.context_id || '',
    courseName: body.context_title || 'Course',
    name: body.lis_person_name_full || body.lis_person_name_given || 'Student',
    isInstructor,
    role: isInstructor ? 'instructor' : 'student'
  }
}

module.exports = { extractLTI, verifyLTISignature, CONSUMER_KEY, CONSUMER_SECRET }
