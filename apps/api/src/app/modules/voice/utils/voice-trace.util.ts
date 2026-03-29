import * as fs from 'node:fs'

const TRACE_FILE = '/tmp/voice-turn-trace.jsonl'

export function appendVoiceTrace(event: Record<string, unknown>): void {
  try {
    console.log('[voice-trace] writing', TRACE_FILE)
    fs.appendFileSync(
      TRACE_FILE,
      JSON.stringify({
        ts: new Date().toISOString(),
        ...event,
      }) + '\n',
    )
  } catch (error) {
    console.error('[voice-trace] append failed', error)
  }
}
