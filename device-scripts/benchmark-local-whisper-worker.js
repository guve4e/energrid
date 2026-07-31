#!/usr/bin/env node
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const readline = require('readline')

const rootDir = path.resolve(__dirname, '..')
const defaultPython = path.join(rootDir, '.venv', 'bin', 'python')
const python = process.env.LOCAL_WHISPER_PYTHON || (
  fs.existsSync(defaultPython) ? defaultPython : 'python3'
)
const workerScript =
  process.env.LOCAL_WHISPER_WORKER_SCRIPT ||
  path.join(rootDir, 'apps/api/src/assets/local-whisper-worker.py')

function usage() {
  console.log(
    [
      'Usage: node device-scripts/benchmark-local-whisper-worker.js <audio.wav> [more.wav ...]',
      '',
      'Starts one persistent faster-whisper worker and sends every file through it.',
      'This measures the mode used by the API when LOCAL_WHISPER_WORKER is not false.',
    ].join('\n'),
  )
}

function parseArgs(argv) {
  const files = argv.slice(2)

  if (files.includes('--help') || files.includes('-h')) {
    usage()
    process.exit(0)
  }

  if (!files.length) {
    usage()
    process.exit(1)
  }

  return files
}

function startWorker() {
  const startedAt = Date.now()
  const child = spawn(python, [workerScript], {
    cwd: rootDir,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const lines = readline.createInterface({
    input: child.stdout,
    crlfDelay: Infinity,
  })
  const pending = new Map()

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf8').trim()
    if (text) console.log(`[worker] ${text}`)
  })

  lines.on('line', (line) => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      console.log(`[worker] ${line}`)
      return
    }

    if (message.type === 'ready') {
      console.log(`[worker] ready model=${message.text} load=${message.durationMs}ms wall=${Date.now() - startedAt}ms`)
      return
    }

    const request = pending.get(message.id)
    if (!request) return

    pending.delete(message.id)
    if (message.error) {
      request.reject(new Error(message.error))
      return
    }

    request.resolve(message)
  })

  child.on('exit', (code, signal) => {
    for (const request of pending.values()) {
      request.reject(new Error(`worker exited code=${code ?? '-'} signal=${signal ?? '-'}`))
    }
    pending.clear()
  })

  return { child, pending }
}

function transcribe(worker, filePath) {
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const audioPath = path.resolve(rootDir, filePath)
  const startedAt = Date.now()

  return new Promise((resolve, reject) => {
    worker.pending.set(id, { resolve, reject })
    worker.child.stdin.write(`${JSON.stringify({ id, audioPath })}\n`, 'utf8')
  }).then((message) => ({
    filePath: audioPath,
    text: message.text || '',
    durationMs: message.durationMs,
    wallMs: Date.now() - startedAt,
  }))
}

async function main() {
  const files = parseArgs(process.argv)
  const model =
    process.env.LOCAL_WHISPER_MODEL_PATH ||
    process.env.LOCAL_WHISPER_MODEL ||
    'small'

  console.log(
    `[local-stt-worker] python=${python} model=${model} device=${process.env.LOCAL_WHISPER_DEVICE || 'cpu'} compute=${process.env.LOCAL_WHISPER_COMPUTE_TYPE || 'int8'} language=${process.env.LOCAL_WHISPER_LANGUAGE || 'bg'}`,
  )

  const worker = startWorker()

  try {
    for (const file of files) {
      const result = await transcribe(worker, file)
      console.log(
        `[local-stt-worker] file=${path.relative(rootDir, result.filePath)} duration=${result.durationMs}ms wall=${result.wallMs}ms text="${result.text}"`,
      )
    }
  } finally {
    worker.child.kill()
  }
}

main().catch((error) => {
  console.error(`[local-stt-worker] ${error.message}`)
  process.exit(1)
})
