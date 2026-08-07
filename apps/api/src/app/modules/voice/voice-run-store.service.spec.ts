import { mkdtempSync, rmSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VoiceRunStoreService } from './voice-run-store.service'
import type { ActiveVoiceSession } from './voice-session.types'

describe('VoiceRunStoreService', () => {
  let dir: string
  let previousFile: string | undefined
  let previousEnabled: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'energrid-voice-runs-'))
    previousFile = process.env.VOICE_RUNS_FILE
    previousEnabled = process.env.VOICE_RUNS_ENABLED
    process.env.VOICE_RUNS_FILE = join(dir, 'runs.jsonl')
    delete process.env.VOICE_RUNS_ENABLED
  })

  afterEach(() => {
    if (previousFile == null) delete process.env.VOICE_RUNS_FILE
    else process.env.VOICE_RUNS_FILE = previousFile

    if (previousEnabled == null) delete process.env.VOICE_RUNS_ENABLED
    else process.env.VOICE_RUNS_ENABLED = previousEnabled

    rmSync(dir, { recursive: true, force: true })
  })

  it('persists a completed turn and returns newest runs first', () => {
    const store = new VoiceRunStoreService()

    const first = makeSession('session-1', 1000, 'Включи лампите в банята.')
    first.turnEndEmittedAt = 2000
    const second = makeSession('session-2', 3000, 'Колко е топло в кухнята?')
    second.turnEndEmittedAt = 4000

    store.recordTurn(first, { totalMs: 1000 })
    store.recordTurn(second, { totalMs: 1000 })

    expect(store.listRecent(2).map((run) => run.sessionId)).toEqual([
      'session-2',
      'session-1',
    ])
    expect(store.listRecent(1)).toHaveLength(1)
    expect(store.listRecent(10)[0]).toEqual(
      expect.objectContaining({
        transcript: 'Колко е топло в кухнята?',
        intent: 'temperature_status',
        runtime: expect.objectContaining({ sttProvider: 'openai' }),
      }),
    )
  })

  it('ignores invalid json lines when reading the run file', () => {
    const store = new VoiceRunStoreService()
    const session = makeSession('session-1', 1000, 'test')
    session.turnEndEmittedAt = 2000

    store.recordTurn(session, { totalMs: 1000 })
    appendFileSync(process.env.VOICE_RUNS_FILE as string, 'not-json\n')

    expect(store.listRecent(10)).toHaveLength(1)
  })

  it('does not write when disabled', () => {
    process.env.VOICE_RUNS_ENABLED = 'false'
    const store = new VoiceRunStoreService()

    expect(store.recordTurn(makeSession('session-1', 1000, 'test'), {})).toBeNull()
    expect(store.listRecent()).toEqual([])
  })
})

function makeSession(
  id: string,
  startedAt: number,
  transcript: string,
): ActiveVoiceSession {
  return {
    id,
    conversationId: `${id}-conversation`,
    client: {} as ActiveVoiceSession['client'],
    sttSession: {} as ActiveVoiceSession['sttSession'],
    chunkCount: 3,
    audioChunks: [],
    partialTranscript: '',
    finalTranscript: transcript,
    assistantReply: 'ok',
    homeIntentClassification: {
      intent: transcript.includes('топло') ? 'temperature_status' : 'turn_on_lights',
      confidence: 0.9,
      reason: 'test',
    },
    homeIntentPlan: null,
    homeActionExecutionResults: [],
    errorMessages: [],
    startedAt,
    firstChunkAt: startedAt,
    lastChunkAt: startedAt + 500,
    turnEndedAt: startedAt + 600,
    sttInputEndedAt: startedAt + 600,
    turnEnded: true,
    clientTurnEnded: true,
    finalized: true,
    assistantStarted: true,
    pendingFinalTranscript: '',
    pendingFinalTimer: null,
    sttFinalCandidateAt: startedAt + 700,
    sttFinalAt: startedAt + 700,
    assistantFirstDeltaAt: startedAt + 800,
    assistantFirstAudioAt: startedAt + 900,
    assistantFinalAt: startedAt + 1000,
    turnEndEmittedAt: null,
    timings: {},
    counters: {},
    audioAnalysis: {
      rmsDb: -20,
      peakDb: -4,
      rms: 0.1,
      peak: 0.9,
      sampleCount: 16000,
      speechGatePassed: true,
    },
  }
}
