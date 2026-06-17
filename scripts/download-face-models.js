/**
 * Downloads face-api.js and TinyFaceDetector model weights to public/
 * so they can be served locally (avoids Canvas CSP blocking CDN scripts).
 *
 * Run once: npm run setup-models
 */

const https = require('https')
const http = require('http')
const fs = require('fs')
const path = require('path')

const BASE = path.join(__dirname, '..', 'public')
const JS_DIR = path.join(BASE, 'js')
const MODELS_DIR = path.join(BASE, 'face-models')

;[BASE, JS_DIR, MODELS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }))

// face-api.js library is in npm; model weights are only in the GitHub repo
const NPM_CDN = 'https://cdn.jsdelivr.net/npm/face-api.js@0.22.2'
const GH_CDN  = 'https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@0.22.2'

const FILES = [
  { url: `${NPM_CDN}/dist/face-api.min.js`,       dest: path.join(JS_DIR, 'face-api.min.js') },
  { url: `${GH_CDN}/weights/tiny_face_detector_model-weights_manifest.json`, dest: path.join(MODELS_DIR, 'tiny_face_detector_model-weights_manifest.json') },
  { url: `${GH_CDN}/weights/tiny_face_detector_model-shard1`,                dest: path.join(MODELS_DIR, 'tiny_face_detector_model-shard1') },
]

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http
    const file = fs.createWriteStream(dest)
    console.log(`  ↓ ${path.basename(dest)}`)
    client.get(url, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close()
        return download(res.headers.location, dest).then(resolve).catch(reject)
      }
      if (res.statusCode !== 200) {
        file.close()
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`))
      }
      res.pipe(file)
      file.on('finish', () => { file.close(); resolve() })
    }).on('error', err => { fs.unlink(dest, () => {}); reject(err) })
  })
}

;(async () => {
  console.log('Downloading face-api.js and model weights...')
  for (const f of FILES) {
    try {
      await download(f.url, f.dest)
    } catch (e) {
      console.error(`  ✗ Failed: ${e.message}`)
      process.exit(1)
    }
  }
  console.log('\n✓ Done — face models saved to public/')
  console.log('  Restart your server and face detection should work.')
})()
