# Canvas Proctoring LTI

A real-time proctoring tool for Canvas LMS, built as an LTI 1.1 external tool. It monitors students during online exams using webcam face detection, audio monitoring, and behavioral tracking — all reviewed by instructors through a built-in admin dashboard.

---

## Features

- **Face Detection** — TinyFaceDetector (face-api.js) runs continuously; blocks exam if multiple people are detected
- **Webcam Captures** — Scheduled snapshots every N seconds; flagged captures on violations
- **Audio Monitoring** — Microphone level tracking; sustained loud audio is flagged
- **Tab / Window Tracking** — Tab switches, window blur, fullscreen exit all logged as violations
- **Identity Challenges** — Periodic re-verification prompts during the exam
- **Auto-End on Submit** — Session ends automatically when the student submits their quiz
- **Admin Dashboard** — Instructors see live session stats, recent events, flagged captures, and can mark sessions as cleared or suspicious
- **LTI OAuth 1.0a** — Full HMAC-SHA1 signature verification with replay attack prevention
- **Instructor Auth** — HttpOnly cookie-based tokens (24h), course-isolated — instructors only see their own course data

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Server | Node.js / Express |
| Database | SQLite (better-sqlite3) |
| Templating | EJS |
| Face Detection | face-api.js (TinyFaceDetector) |
| LTI | LTI 1.1 / OAuth 1.0a HMAC-SHA1 |
| Canvas Integration | Canvas REST API |

---

## Project Structure

```
proctoring/
├── src/
│   ├── app.js          # Express routes and middleware
│   ├── database.js     # SQLite schema and queries
│   └── lti.js          # LTI OAuth signature verification
├── views/
│   ├── pre_exam.ejs    # Student pre-exam check (quiz select, webcam, face verify)
│   ├── student.ejs     # Live proctoring view (student)
│   ├── instructor.ejs  # Admin dashboard
│   └── session_detail.ejs  # Per-session review with captures and events
├── public/
│   ├── js/
│   │   └── face-api.min.js       # Served locally (avoids Canvas CSP)
│   └── face-models/
│       ├── tiny_face_detector_model-weights_manifest.json
│       └── tiny_face_detector_model-shard1
├── scripts/
│   └── download-face-models.js   # One-time setup script
├── data/               # SQLite database (auto-created, gitignored)
├── captures/           # Webcam snapshots (auto-created, gitignored)
└── .env                # Environment variables (gitignored)
```

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Download face detection models

```bash
npm run setup-models
```

This downloads `face-api.min.js` and the TinyFaceDetector model weights into `public/` so they are served from your own server (required — Canvas CSP blocks external CDNs).

### 3. Configure environment

Create a `.env` file in the project root:

```env
PORT=8083
HOST=https://your-server.com

LTI_CONSUMER_KEY=your-lti-key
LTI_CONSUMER_SECRET=your-lti-secret

CANVAS_URL=https://your-canvas-instance.instructure.com
CANVAS_API_TOKEN=your-canvas-api-token

CAPTURE_INTERVAL=30
FLAG_THRESHOLD=3

# Optional: set if your server is behind a reverse proxy
LAUNCH_URL=https://your-server.com/launch
```

### 4. Start the server

```bash
# Production
npm start

# Development (auto-restart)
npm run dev
```

---

## Canvas LTI Configuration

In Canvas, add an External Tool with these settings:

| Field | Value |
|-------|-------|
| Name | Canvas Proctoring |
| Consumer Key | *(value of `LTI_CONSUMER_KEY`)* |
| Shared Secret | *(value of `LTI_CONSUMER_SECRET`)* |
| Launch URL | `https://your-server.com/launch` |
| Privacy | **Public** (required — tool needs name and user ID) |
| Domain | `your-server.com` |

---

## How It Works

### Student Flow
1. Student launches the tool from Canvas → **Pre-Exam Check** (select quiz, webcam test, face verification)
2. If multiple faces detected → full-screen block until room is clear
3. Student proceeds to **Proctoring View** → clicks "Open Quiz" (new tab)
4. Proctoring runs: captures every 30s, face detection every 5s, audio monitored continuously
5. On quiz submit → session ends automatically; or student clicks "End Session"

### Instructor Flow
1. Instructor launches the tool from Canvas → **Admin Dashboard**
2. View all sessions, stats, recent flagged events
3. Click any session → **Session Review** with all captures and events
4. Mark sessions as **Cleared** or **Suspicious**

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8083` | Server port |
| `HOST` | `http://localhost:8083` | Public base URL |
| `LAUNCH_URL` | `{HOST}/launch` | LTI launch URL (set explicitly behind proxies) |
| `LTI_CONSUMER_KEY` | `proctoring-key` | LTI key configured in Canvas |
| `LTI_CONSUMER_SECRET` | `proctoring-secret` | LTI secret configured in Canvas |
| `CANVAS_URL` | — | Your Canvas instance base URL |
| `CANVAS_API_TOKEN` | — | Canvas API token for quiz/submission lookup |
| `CAPTURE_INTERVAL` | `30` | Seconds between webcam captures |
| `FLAG_THRESHOLD` | `3` | Flag count before session is highlighted |

---

## Security

- LTI launches verified with full **OAuth 1.0a HMAC-SHA1** signature + timestamp + nonce replay prevention
- Instructor routes protected by **HttpOnly cookie tokens** (24h expiry)
- Course isolation — instructors cannot access sessions from other courses
- Webcam captures served via authenticated route only (no public static access)
- Path traversal prevention on all file routes
- Input validation and rate limiting on capture endpoint (max 15/min per session)
- No internal error details exposed to clients

---

## License

MIT
