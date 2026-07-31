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
  firstChunkAt: number | null
  lastChunkAt: number
  turnEndedAt: number | null
  sttInputEndedAt: number | null

  turnEnded: boolean
  clientTurnEnded: boolean
  finalized: boolean
  assistantStarted: boolean

  pendingFinalTranscript: string
  pendingFinalTimer: NodeJS.Timeout | null

  sttFinalCandidateAt: number | null
  sttFinalAt: number | null
  assistantFirstDeltaAt: number | null
  assistantFirstAudioAt: number | null
  assistantFinalAt: number | null
  turnEndEmittedAt: number | null
  timings: Record<string, number>
  counters: Record<string, number>
  audioAnalysis: {
    rmsDb: number | null
    peakDb: number | null
    rms: number
    peak: number
    sampleCount: number
    speechGatePassed: boolean | null
  }
}
