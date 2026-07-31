#!/usr/bin/env node
const { spawn } = require('child_process')
const path = require('path')

const rootDir = path.resolve(__dirname, '..')
const replayScript = path.join(__dirname, 'replay-wav-to-voice.js')

const cases = [
  {
    name: 'home command fast path',
    args: [
      'samples/voice/close-command.wav',
      '--expect-transcript',
      'ламп',
      '--expect-reply',
      'Включвам',
      '--expect-home-intent',
      'turn_on_lights',
      '--require-audio',
      '--require-metrics',
      '--require-fast-path',
    ],
  },
  {
    name: 'quiet home command fast path',
    args: [
      'samples/voice/fixtures/close-command-quiet.wav',
      '--expect-transcript',
      'ламп',
      '--expect-home-intent',
      'turn_on_lights',
      '--require-audio',
      '--require-metrics',
      '--require-fast-path',
    ],
  },
  {
    name: 'silence is ignored',
    args: [
      'samples/voice/fixtures/silence-5s.wav',
      '--require-metrics',
      '--forbid-transcript',
      '--forbid-audio',
    ],
  },
]

async function runCase(testCase) {
  console.log(`\n[voice-suite] ${testCase.name}`)

  const exitCode = await new Promise((resolve) => {
    const child = spawn(process.execPath, [replayScript, ...testCase.args], {
      cwd: rootDir,
      env: process.env,
      stdio: 'inherit',
    })

    child.on('close', resolve)
  })

  if (exitCode !== 0) {
    throw new Error(`${testCase.name} failed with exit code ${exitCode}`)
  }
}

async function main() {
  for (const testCase of cases) {
    await runCase(testCase)
  }

  console.log('\n[voice-suite] passed')
}

main().catch((error) => {
  console.error(`\n[voice-suite] ${error.message}`)
  process.exit(1)
})
