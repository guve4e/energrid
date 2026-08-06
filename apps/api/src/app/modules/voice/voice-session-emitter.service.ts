import { Injectable, Logger } from '@nestjs/common'
import { WebSocket } from 'ws'

import { DebugEventsService } from './debug-events.service'
import type { ActiveVoiceSession } from './voice-session.types'
import type { ClassifyHomeIntentResult, HomeIntentPlan } from '@energrid/domain-automation'
import type { HomeActionExecutionResult } from './home-automation.service'

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

  emitHomeActionPlan(
    session: ActiveVoiceSession,
    classification: ClassifyHomeIntentResult,
    plan: HomeIntentPlan,
  ): void {
    this.emitToBoth(session, {
      type: 'home_action_plan',
      sessionId: session.id,
      classification,
      plan,
    })
  }

  emitHomeActionExecution(
    session: ActiveVoiceSession,
    results: HomeActionExecutionResult[],
  ): void {
    this.emitToBoth(session, {
      type: 'home_action_execution',
      sessionId: session.id,
      results,
    })
  }

  emitTurnEnd(session: ActiveVoiceSession): void {
    session.turnEndEmittedAt = Date.now()

    const metrics = {
      totalMs: session.turnEndEmittedAt - session.startedAt,
      sttMs:
        session.sttFinalAt != null ? session.sttFinalAt - session.startedAt : null,
      firstTextMs:
        session.assistantFirstDeltaAt != null && session.sttFinalAt != null
          ? session.assistantFirstDeltaAt - session.sttFinalAt
          : null,
      firstAudioMs:
        session.assistantFirstAudioAt != null && session.sttFinalAt != null
          ? session.assistantFirstAudioAt - session.sttFinalAt
          : null,
      assistantCompleteMs:
        session.assistantFinalAt != null && session.sttFinalAt != null
          ? session.assistantFinalAt - session.sttFinalAt
          : null,
      speechGatePassed: session.audioAnalysis.speechGatePassed,
      audioRmsDb: session.audioAnalysis.rmsDb,
      audioPeakDb: session.audioAnalysis.peakDb,
      llmFirstDeltaMs:
        session.timings.llmRequestStartedAt != null &&
        session.timings.llmFirstDeltaAt != null
          ? session.timings.llmFirstDeltaAt -
            session.timings.llmRequestStartedAt
          : null,
      firstTtsDurationMs: session.timings.ttsChunk0DurationMs ?? null,
      ttsTotalMs:
        session.timings.firstTtsRequestAt != null &&
        session.timings.lastTtsCompletedAt != null
          ? session.timings.lastTtsCompletedAt -
            session.timings.firstTtsRequestAt
          : null,
      commandFastPath: session.counters.commandFastPath === 1,
      chunkCount: session.chunkCount,
    }

    this.emitToBoth(session, {
      type: 'turn_end',
      sessionId: session.id,
      metrics,
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
