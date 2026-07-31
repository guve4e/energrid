#!/usr/bin/env node
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const rootDir = path.resolve(__dirname, '..')
const defaultPython = path.join(rootDir, '.venv', 'bin', 'python')
const python = process.env.LOCAL_WHISPER_PYTHON || (
  fs.existsSync(defaultPython) ? defaultPython : 'python3'
)
const script =
  process.env.LOCAL_WHISPER_SCRIPT ||
  path.join(rootDir, 'apps/api/src/assets/local-whisper-transcribe.py')

function usage() {
  console.log(
    [
      'Usage: node device-scripts/benchmark-local-whisper.js <audio.wav> [more.wav ...]',
      '',
      'Environment:',
      '  LOCAL_WHISPER_PYTHON       Python executable, defaults to .venv/bin/python when present',
      '  LOCAL_WHISPER_MODEL        faster-whisper model name, defaults to small',
      '  LOCAL_WHISPER_MODEL_PATH   exported/custom model path',
      '  LOCAL_WHISPER_DEVICE       cpu/cuda/auto, defaults to cpu',
      '  LOCAL_WHISPER_COMPUTE_TYPE int8/float16/float32, defaults to int8',
      '  LOCAL_WHISPER_LANGUAGE     language code, defaults to bg',
    ].join('\n'),
  )
}

function parseArgs(argv) {
  const files = []

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i]

    if (arg === '--help' || arg === '-h') {
      usage()
      process.exit(0)
    }

    files.push(arg)
  }

  if (!files.length) {
    usage()
    process.exit(1)
  }

  return files
}

function runWhisper(filePath) {
  const startedAt = Date.now()
  const resolvedPath = path.resolve(rootDir, filePath)

  return new Promise((resolve, reject) => {
    const child = spawn(python, [script, resolvedPath], {
      cwd: rootDir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
    })

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })

    child.on('error', reject)
    child.on('close', (code) => {
      const durationMs = Date.now() - startedAt
      const transcript = stdout.trim()

      resolve({
        code,
        durationMs,
        transcript,
        stderr: stderr.trim(),
        filePath: resolvedPath,
      })
    })
  })
}

async function main() {
  const files = parseArgs(process.argv)
  const model =
    process.env.LOCAL_WHISPER_MODEL_PATH ||
    process.env.LOCAL_WHISPER_MODEL ||
    'small'

  console.log(
    `[local-stt] python=${python} model=${model} device=${process.env.LOCAL_WHISPER_DEVICE || 'cpu'} compute=${process.env.LOCAL_WHISPER_COMPUTE_TYPE || 'int8'} language=${process.env.LOCAL_WHISPER_LANGUAGE || 'bg'}`,
  )

  let failed = false

  for (const file of files) {
    const result = await runWhisper(file)
    const relative = path.relative(rootDir, result.filePath)

    if (result.code !== 0) {
      failed = true
      console.error(
        `[local-stt] failed file=${relative} code=${result.code} duration=${result.durationMs}ms`,
      )
      if (result.stderr) console.error(result.stderr)
      continue
    }

    console.log(
      `[local-stt] file=${relative} duration=${result.durationMs}ms text="${result.transcript}"`,
    )
  }

  if (failed) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(`[local-stt] ${error.message}`)
  process.exit(1)
})
