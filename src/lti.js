const CONSUMER_KEY = process.env.LTI_CONSUMER_KEY || 'proctoring-key'
const CONSUMER_SECRET = process.env.LTI_CONSUMER_SECRET || 'proctoring-secret'

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
    // No more quizName/quizUrl from custom fields — fetched from Canvas API now
    isInstructor,
    role: isInstructor ? 'instructor' : 'student'
  }
}

module.exports = { extractLTI, CONSUMER_KEY, CONSUMER_SECRET }
