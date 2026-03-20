import { StreamingSttSession } from '@energrid/stt-stream-core'
import { WebSocket } from 'ws'

export type VoiceSessionId = string

export interface ActiveVoiceSession {
  id: VoiceSessionId
  client: WebSocket
  sttSession: StreamingSttSession

  chunkCount: number

  partialTranscript: string
  finalTranscript: string

  startedAt: number
  lastChunkAt: number
}
