import { Injectable, Logger } from '@nestjs/common'
import { WebSocket } from 'ws'

import { DebugEventsService } from './debug-events.service'
import type { ActiveVoiceSession } from './voice-session.types'

export interface AssistantAudioChunkEvent {
  chunkIndex: number
  isLastChunk: boolean
  text: string
  format: string
  audioBuffer: Buffer
}

@Injectable()
export class VoiceSessionEmitterService {
  private readonly logger = new Logger(VoiceSessionEmitterService.name)

  constructor(private readonly debugEvents: DebugEventsService) {}

  sendToClient(
    session: ActiveVoiceSession,
    event: Record<string, unknown>,
  ): void {
    try {
      if (session.client.readyState === WebSocket.OPEN) {
        session.client.send(JSON.stringify(event))
      }
    } catch (error) {
      this.logger.warn(`Failed to send event to client: ${String(error)}`)
    }
  }

  emitToBoth(
    session: ActiveVoiceSession,
    clientEvent: Record<string, unknown>,
    debugEvent?: Record<string, unknown>,
  ): void {
    this.sendToClient(session, clientEvent)
    this.debugEvents.emit(debugEvent ?? clientEvent)
  }

  emitSessionStart(session: ActiveVoiceSession): void {
    this.emitToBoth(session, {
      type: 'session_start',
      sessionId: session.id,
      conversationId: session.conversationId,
    })
  }

  emitSttPartial(session: ActiveVoiceSession, text: string): void {
    this.emitToBoth(session, {
      type: 'stt_partial',
      sessionId: session.id,
      text,
      full: session.partialTranscript,
    })
  }

  emitSttFinal(session: ActiveVoiceSession): void {
    this.emitToBoth(session, {
      type: 'stt_final',
      sessionId: session.id,
      text: session.finalTranscript,
      full: session.finalTranscript,
    })
  }

  emitAssistantTextDelta(
    session: ActiveVoiceSession,
    delta: string,
    full: string,
  ): void {
    this.sendToClient(session, {
      type: 'assistant_text_delta',
      sessionId: session.id,
      delta,
      full,
    })
  }

  emitAssistantAudioChunk(
    session: ActiveVoiceSession,
    chunk: AssistantAudioChunkEvent,
  ): void {
    this.sendToClient(session, {
      type: 'assistant_audio_chunk',
      sessionId: session.id,
      format: chunk.format,
      chunkIndex: chunk.chunkIndex,
      isLastChunk: chunk.isLastChunk,
      text: chunk.text,
      audioBase64: chunk.audioBuffer.toString('base64'),
    })

    this.debugEvents.emit({
      type: 'assistant_audio_chunk',
      sessionId: session.id,
      format: chunk.format,
      bytes: chunk.audioBuffer.length,
      chunkIndex: chunk.chunkIndex,
      isLastChunk: chunk.isLastChunk,
      text: chunk.text,
    })
  }

  emitAssistantFinal(session: ActiveVoiceSession): void {
    this.emitToBoth(session, {
      type: 'assistant_final',
      sessionId: session.id,
      text: session.assistantReply,
    })
  }

  emitTurnEnd(session: ActiveVoiceSession): void {
    this.emitToBoth(session, {
      type: 'turn_end',
      sessionId: session.id,
    })
  }

  emitError(session: ActiveVoiceSession, message: string): void {
    this.emitToBoth(session, {
      type: 'error',
      sessionId: session.id,
      message,
    })
  }

  emitChunkDebug(
    session: ActiveVoiceSession,
    bytes: number,
  ): void {
    this.debugEvents.emit({
      type: 'chunk',
      sessionId: session.id,
      chunkCount: session.chunkCount,
      bytes,
    })
  }
}
