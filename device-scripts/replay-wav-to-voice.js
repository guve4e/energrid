#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const WebSocket = require('ws')

const DEFAULT_WS_URL = process.env.VOICE_WS_URL || 'ws://localhost:3000/voice'
const DEFAULT_CHUNK_SAMPLES = Number(process.env.PCM_CHUNK_SAMPLES || 4096)
const DEFAULT_OUTPUT_DIR = process.env.VOICE_REPLAY_OUTPUT_DIR || 'samples/voice/replay-output'

function usage() {
  console.log(
    [
      'Usage: node device-scripts/replay-wav-to-voice.js <audio.wav> [options]',
      '',
      'Options:',
      '  --ws <url>              Voice WebSocket URL',
      '  --chunk-samples <n>     PCM16 samples per chunk',
      '  --fast                 Send chunks without real-time pacing',
      '  --play                 Play assistant WAV chunks as they arrive',
      '  --output-dir <dir>      Directory for assistant WAV chunks',
      '  --expect-transcript <s> Assert stt_final contains this text',
      '  --expect-reply <s>      Assert assistant_final contains this text',
      '  --expect-home-intent <s> Assert home_action_plan has this intent',
      '  --require-audio         Assert at least one assistant audio chunk arrives',
      '  --forbid-audio          Assert no assistant audio chunks arrive',
      '  --require-metrics       Assert turn_end includes metrics',
      '  --require-fast-path     Assert metrics.commandFastPath is true',
      '  --forbid-transcript     Assert no stt_final text arrives',
      '  --timeout-ms <n>        Wait timeout after end_of_turn',
      '',
      'Expected input: 16kHz mono PCM16 WAV.',
    ].join('\n'),
  )
}

function parseArgs(argv) {
  const args = {
    wavPath: '',
    wsUrl: DEFAULT_WS_URL,
    chunkSamples: DEFAULT_CHUNK_SAMPLES,
    fast: false,
    play: false,
    outputDir: DEFAULT_OUTPUT_DIR,
    expectTranscript: '',
    expectReply: '',
    expectHomeIntent: '',
    requireAudio: false,
    forbidAudio: false,
    requireMetrics: false,
    requireFastPath: false,
    forbidTranscript: false,
    timeoutMs: 30000,
  }

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i]

    if (arg === '--help' || arg === '-h') {
      usage()
      process.exit(0)
    }

    if (arg === '--ws') {
      args.wsUrl = argv[++i]
      continue
    }

    if (arg === '--chunk-samples') {
      args.chunkSamples = Number(argv[++i])
      continue
    }

    if (arg === '--fast') {
      args.fast = true
      continue
    }

    if (arg === '--play') {
      args.play = true
      continue
    }

    if (arg === '--output-dir') {
      args.outputDir = argv[++i]
      continue
    }

    if (arg === '--expect-transcript') {
      args.expectTranscript = argv[++i]
      continue
    }

    if (arg === '--expect-reply') {
      args.expectReply = argv[++i]
      continue
    }

    if (arg === '--expect-home-intent') {
      args.expectHomeIntent = argv[++i]
      continue
    }

    if (arg === '--require-audio') {
      args.requireAudio = true
      continue
    }

    if (arg === '--forbid-audio') {
      args.forbidAudio = true
      continue
    }

    if (arg === '--require-metrics') {
      args.requireMetrics = true
      continue
    }

    if (arg === '--require-fast-path') {
      args.requireFastPath = true
      args.requireMetrics = true
      continue
    }

    if (arg === '--forbid-transcript') {
      args.forbidTranscript = true
      continue
    }

    if (arg === '--timeout-ms') {
      args.timeoutMs = Number(argv[++i])
      continue
    }

    if (!args.wavPath) {
      args.wavPath = arg
      continue
    }

    throw new Error(`Unexpected argument: ${arg}`)
  }

  if (!args.wavPath) {
    usage()
    process.exit(1)
  }

  if (!Number.isFinite(args.chunkSamples) || args.chunkSamples <= 0) {
    throw new Error('--chunk-samples must be a positive number')
  }

  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive number')
  }

  return args
}

function readWav(filePath) {
  const buffer = fs.readFileSync(filePath)

  if (buffer.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error('Not a RIFF file')
  }

  if (buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a WAVE file')
  }

  let offset = 12
  let fmt = null
  let pcm = null

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4)
    const chunkSize = buffer.readUInt32LE(offset + 4)
    const chunkStart = offset + 8
    const chunkEnd = chunkStart + chunkSize

    if (chunkEnd > buffer.length) {
      throw new Error(`Invalid WAV chunk size for ${chunkId}`)
    }

    if (chunkId === 'fmt ') {
      fmt = {
        audioFormat: buffer.readUInt16LE(chunkStart),
        channels: buffer.readUInt16LE(chunkStart + 2),
        sampleRate: buffer.readUInt32LE(chunkStart + 4),
        bitsPerSample: buffer.readUInt16LE(chunkStart + 14),
      }
    }

    if (chunkId === 'data') {
      pcm = buffer.subarray(chunkStart, chunkEnd)
    }

    offset = chunkEnd + (chunkSize % 2)
  }

  if (!fmt) throw new Error('WAV fmt chunk not found')
  if (!pcm) throw new Error('WAV data chunk not found')

  if (
    fmt.audioFormat !== 1 ||
    fmt.channels !== 1 ||
    fmt.sampleRate !== 16000 ||
    fmt.bitsPerSample !== 16
  ) {
    throw new Error(
      `Expected 16kHz mono PCM16 WAV, got format=${fmt.audioFormat} channels=${fmt.channels} sampleRate=${fmt.sampleRate} bits=${fmt.bitsPerSample}`,
    )
  }

  return { fmt, pcm }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function playAudio(filePath) {
  const player = process.platform === 'darwin' ? 'afplay' : 'aplay'
  const child = spawn(player, [filePath], {
    stdio: 'ignore',
    detached: true,
  })
  child.unref()
}

function createReplayState() {
  return {
    sessionStarted: false,
    sttFinal: '',
    assistantFinal: '',
    audioChunkCount: 0,
    audioBytes: 0,
    homeActionPlan: null,
    turnEnded: false,
    error: '',
    metrics: null,
  }
}

function createMessageLogger(args, outputBaseName, state) {
  const outputDir = path.resolve(args.outputDir)
  fs.mkdirSync(outputDir, { recursive: true })

  return function logMessage(raw) {
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)

    let event
    try {
      event = JSON.parse(text)
    } catch {
      console.log(`[recv] ${text}`)
      return
    }

    switch (event.type) {
      case 'session_start':
        state.sessionStarted = true
        console.log(
          `[recv] session_start session=${event.sessionId} conversation=${event.conversationId}`,
        )
        return

      case 'stt_partial':
        console.log(`[recv] stt_partial ${event.full || event.text || ''}`)
        return

      case 'stt_final':
        state.sttFinal = event.full || event.text || ''
        console.log(`[recv] stt_final ${state.sttFinal}`)
        return

      case 'assistant_text_delta':
        process.stdout.write(event.delta || '')
        return

      case 'assistant_audio_chunk': {
        if (state.audioChunkCount === 0) {
          process.stdout.write('\n')
        }

        const chunkIndex = event.chunkIndex ?? state.audioChunkCount
        const audioPath = path.join(
          outputDir,
          `${outputBaseName}-assistant-${String(chunkIndex).padStart(2, '0')}.wav`,
        )
        const audio = Buffer.from(event.audioBase64 || '', 'base64')

        fs.writeFileSync(audioPath, audio)
        state.audioChunkCount += 1
        state.audioBytes += audio.length

        console.log(
          `[recv] assistant_audio_chunk index=${chunkIndex} bytes=${audio.length} saved=${audioPath}`,
        )

        if (args.play) {
          playAudio(audioPath)
        }

        return
      }

      case 'home_action_plan':
        state.homeActionPlan = {
          classification: event.classification || null,
          plan: event.plan || null,
        }
        console.log(
          `[recv] home_action_plan intent=${event.classification?.intent || '-'} actions=${event.plan?.actions?.length ?? 0} confirmation=${event.plan?.requiresConfirmation ?? false}`,
        )
        return

      case 'assistant_final':
        state.assistantFinal = event.text || ''
        console.log(`[recv] assistant_final ${state.assistantFinal}`)
        return

      case 'turn_end':
        state.turnEnded = true
        state.metrics = event.metrics || null
        console.log(`[recv] turn_end session=${event.sessionId || ''}`)
        if (event.metrics) {
          console.log(
            `[metrics] total=${formatMs(event.metrics.totalMs)} stt=${formatMs(event.metrics.sttMs)} llm_first=${formatMs(event.metrics.llmFirstDeltaMs)} first_audio=${formatMs(event.metrics.firstAudioMs)} first_tts=${formatMs(event.metrics.firstTtsDurationMs)} tts_total=${formatMs(event.metrics.ttsTotalMs)} assistant=${formatMs(event.metrics.assistantCompleteMs)} chunks=${event.metrics.chunkCount ?? '-'}`,
          )
          if (event.metrics.commandFastPath) {
            console.log('[metrics] command_fast_path=true')
          }
          console.log(
            `[audio] gate=${event.metrics.speechGatePassed ?? '-'} rms=${formatDb(event.metrics.audioRmsDb)} peak=${formatDb(event.metrics.audioPeakDb)}`,
          )
        }
        return

      case 'voice_metrics':
        state.metrics = event.metrics || state.metrics
        console.log(`[metrics] ${JSON.stringify(event.metrics)}`)
        return

      case 'error':
        state.error = event.message || 'unknown error'
        console.log(`[recv] error ${state.error}`)
        return

      default:
        console.log(`[recv] ${text}`)
    }
  }
}

function formatMs(ms) {
  return ms == null ? '-' : `${Math.round(ms)}ms`
}

function formatDb(db) {
  if (db == null) return '-'
  if (!Number.isFinite(db)) return '-inf dB'
  return `${db} dB`
}

async function main() {
  const args = parseArgs(process.argv)
  const resolvedWavPath = path.resolve(args.wavPath)
  const { fmt, pcm } = readWav(resolvedWavPath)
  const outputBaseName = path.basename(resolvedWavPath, path.extname(resolvedWavPath))
  const chunkBytes = args.chunkSamples * 2
  const chunks = []

  for (let start = 0; start < pcm.length; start += chunkBytes) {
    chunks.push(pcm.subarray(start, Math.min(start + chunkBytes, pcm.length)))
  }

  console.log(
    `[replay] ${resolvedWavPath} seconds=${(pcm.length / 2 / fmt.sampleRate).toFixed(2)} chunks=${chunks.length} ws=${args.wsUrl}`,
  )

  const ws = new WebSocket(args.wsUrl)
  const state = createReplayState()
  const logMessage = createMessageLogger(args, outputBaseName, state)

  ws.on('message', logMessage)

  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })

  for (const chunk of chunks) {
    ws.send(chunk)

    if (!args.fast) {
      await sleep((chunk.length / 2 / fmt.sampleRate) * 1000)
    }
  }

  ws.send(JSON.stringify({ type: 'end_of_turn' }))
  console.log('[replay] end_of_turn sent')

  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, args.timeoutMs)
    ws.on('message', (raw) => {
      const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)
      try {
        const event = JSON.parse(text)
        if (event.type === 'turn_end' || event.type === 'error') {
          clearTimeout(timeout)
          resolve()
        }
      } catch {
        // Already logged above.
      }
    })
  })

  ws.close()
  assertReplay(args, state)
  printSummary(state)
}

function assertReplay(args, state) {
  const failures = []

  if (!state.sessionStarted) {
    failures.push('session_start was not received')
  }

  if (state.error) {
    failures.push(`server returned error: ${state.error}`)
  }

  if (!state.turnEnded) {
    failures.push('turn_end was not received')
  }

  if (args.expectTranscript && !includesNormalized(state.sttFinal, args.expectTranscript)) {
    failures.push(
      `stt_final did not contain "${args.expectTranscript}" (actual: "${state.sttFinal}")`,
    )
  }

  if (args.expectReply && !includesNormalized(state.assistantFinal, args.expectReply)) {
    failures.push(
      `assistant_final did not contain "${args.expectReply}" (actual: "${state.assistantFinal}")`,
    )
  }

  if (args.forbidTranscript && state.sttFinal.trim()) {
    failures.push(`stt_final was received but should not be (actual: "${state.sttFinal}")`)
  }

  if (
    args.expectHomeIntent &&
    state.homeActionPlan?.classification?.intent !== args.expectHomeIntent
  ) {
    failures.push(
      `home_action_plan intent was not "${args.expectHomeIntent}" (actual: "${state.homeActionPlan?.classification?.intent || '-'}")`,
    )
  }

  if (args.requireAudio && state.audioChunkCount < 1) {
    failures.push('no assistant_audio_chunk events were received')
  }

  if (args.forbidAudio && state.audioChunkCount > 0) {
    failures.push(`assistant_audio_chunk events were received (${state.audioChunkCount})`)
  }

  if (args.requireMetrics && !state.metrics) {
    failures.push('turn_end did not include metrics')
  }

  if (args.requireFastPath && !state.metrics?.commandFastPath) {
    failures.push('metrics.commandFastPath was not true')
  }

  if (failures.length) {
    for (const failure of failures) {
      console.error(`[assert] ${failure}`)
    }
    process.exitCode = 1
  }
}

function includesNormalized(value, expected) {
  return value.toLocaleLowerCase().includes(expected.toLocaleLowerCase())
}

function printSummary(state) {
  const status = process.exitCode ? 'failed' : 'passed'
  const intent = state.homeActionPlan?.classification?.intent
  const fastPath =
    state.metrics?.commandFastPath == null
      ? ''
      : ` fastPath=${state.metrics.commandFastPath}`
  const plan = intent ? ` intent=${intent}` : ''
  console.log(
    `[summary] ${status} stt="${state.sttFinal}" audioChunks=${state.audioChunkCount} audioBytes=${state.audioBytes}${plan}${fastPath}`,
  )
}

main().catch((error) => {
  console.error(`[replay] ${error.message}`)
  process.exit(1)
})
