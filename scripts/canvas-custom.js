/**
 * Canvas Custom JavaScript — Proctoring Paste Detection
 * Add this file content to Canvas: Admin → Settings → Custom JavaScript
 *
 * This detects copy/paste in quiz pages and sends events to the proctoring server.
 */

(function () {
  // Only run on quiz "take" pages
  if (!window.location.pathname.includes('/quizzes/') || !window.location.pathname.includes('/take')) return

  const PROCTOR_URL = 'http://localhost:8083'

  const courseIdMatch = window.location.pathname.match(/\/courses\/(\d+)\//)
  const courseId = courseIdMatch ? courseIdMatch[1] : null
  const canvasUserId = window.ENV && window.ENV.current_user ? String(window.ENV.current_user.id) : null

  if (!courseId || !canvasUserId) return

  function sendEvent(eventType, detail) {
    fetch(PROCTOR_URL + '/api/quiz-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ canvasUserId, courseId, eventType, detail, severity: 'high' })
    }).catch(function () {})
  }

  document.addEventListener('paste', function (e) {
    var pastedText = ''
    try { pastedText = e.clipboardData ? e.clipboardData.getData('text') : '' } catch (_) {}
    sendEvent('paste_in_quiz', 'Student pasted text in quiz (' + pastedText.length + ' chars)')
  })

  document.addEventListener('copy', function () {
    sendEvent('copy_in_quiz', 'Student copied text from quiz page')
  })

  document.addEventListener('cut', function () {
    sendEvent('cut_in_quiz', 'Student cut text from quiz page')
  })
})()
