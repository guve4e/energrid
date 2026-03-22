import { WebSocket } from 'ws'
import type { StreamingSttSession } from '@energrid/stt-stream-core'

export interface ActiveVoiceSession {
  id: string
  conversationId: string
  client: WebSocket
  sttSession: StreamingSttSession

  chunkCount: number
  audioChunks: Buffer[]
  partialTranscript: string
  finalTranscript: string
  assistantReply: string

  startedAt: number
  lastChunkAt: number

  turnEnded: boolean
  clientTurnEnded: boolean
  finalized: boolean
  assistantStarted: boolean

  pendingFinalTranscript: string
  pendingFinalTimer: NodeJS.Timeout | null

  sttFinalAt: number | null
  assistantFirstDeltaAt: number | null
  assistantFirstAudioAt: number | null
  assistantFinalAt: number | null
}
