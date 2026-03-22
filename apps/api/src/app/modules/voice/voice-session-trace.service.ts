import { Injectable, Logger } from '@nestjs/common'
import { DebugEventsService } from './debug-events.service'
import { appendVoiceTrace } from './utils/voice-trace.util'
import type { ActiveVoiceSession } from './voice-session.types'

@Injectable()
export class VoiceSessionTraceService {
  private readonly logger = new Logger(VoiceSessionTraceService.name)

  constructor(private readonly debugEvents: DebugEventsService) {}

  logSessionStart(session: ActiveVoiceSession): void {
    this.logger.log(
      `[SESSION START] ${session.id} conversation=${session.conversationId}`,
    )

    appendVoiceTrace({
      type: 'session_start',
      sessionId: session.id,
      conversationId: session.conversationId,
    })
  }

  logSessionEnd(session: ActiveVoiceSession): void {
    this.logger.log(
      `[SESSION END] ${session.id} conversation=${session.conversationId} transcript="${session.finalTranscript}"`,
    )
  }

  emitSessionEndDebug(session: ActiveVoiceSession): void {
    this.debugEvents.emit({
      type: 'session_end',
      sessionId: session.id,
      conversationId: session.conversationId,
      totalChunks: session.chunkCount,
      finalTranscript: session.finalTranscript.trim(),
      assistantReply: session.assistantReply,
      durationMs: Date.now() - session.startedAt,
    })
  }

  appendSessionEndTrace(session: ActiveVoiceSession): void {
    appendVoiceTrace({
      type: 'session_end',
      sessionId: session.id,
      conversationId: session.conversationId,
      finalTranscript: session.finalTranscript,
      assistantReply: session.assistantReply,
      chunkCount: session.chunkCount,
      bufferedAudioBytes: this.getBufferedAudio(session).length,
      clientTurnEnded: session.clientTurnEnded,
      durationMs: Date.now() - session.startedAt,
      closedAt: Date.now(),
    })
  }

  appendConversationInputTrace(session: ActiveVoiceSession): void {
    appendVoiceTrace({
      type: 'conversation_input',
      sessionId: session.id,
      conversationId: session.conversationId,
      transcript: session.finalTranscript,
    })
  }

  appendSttFinalTrace(session: ActiveVoiceSession): void {
    appendVoiceTrace({
      type: 'stt_final',
      sessionId: session.id,
      conversationId: session.conversationId,
      transcript: session.finalTranscript,
      chunkCount: session.chunkCount,
      startedAt: session.startedAt,
      sttFinalAt: session.sttFinalAt,
    })
  }

  appendAssistantTextDeltaTrace(
    session: ActiveVoiceSession,
    delta: string,
    full: string,
  ): void {
    appendVoiceTrace({
      type: 'assistant_text_delta',
      sessionId: session.id,
      conversationId: session.conversationId,
      delta,
      accumulatedLength: full.length,
    })
  }

  appendAssistantFinalTrace(session: ActiveVoiceSession): void {
    appendVoiceTrace({
      type: 'assistant_final',
      sessionId: session.id,
      conversationId: session.conversationId,
      transcript: session.finalTranscript,
      assistantReply: session.assistantReply,
      assistantFinalAt: session.assistantFinalAt,
    })
  }

  appendBatchUnavailableTrace(
    session: ActiveVoiceSession,
    realtimeTranscript: string,
    bufferedAudio: Buffer,
  ): void {
    appendVoiceTrace({
      type: 'batch_transcription_unavailable',
      sessionId: session.id,
      conversationId: session.conversationId,
      realtimeTranscript,
      bufferedAudioBytes: bufferedAudio.length,
    })
  }

  appendBatchResultTrace(
    session: ActiveVoiceSession,
    realtimeTranscript: string,
    batchTranscript: string,
    chosenTranscript: string,
    bufferedAudio: Buffer,
  ): void {
    appendVoiceTrace({
      type: 'batch_transcription_result',
      sessionId: session.id,
      conversationId: session.conversationId,
      realtimeTranscript,
      batchTranscript,
      chosenTranscript,
      bufferedAudioBytes: bufferedAudio.length,
    })
  }

  appendBatchErrorTrace(
    session: ActiveVoiceSession,
    realtimeTranscript: string,
    bufferedAudio: Buffer,
    message: string,
  ): void {
    appendVoiceTrace({
      type: 'batch_transcription_error',
      sessionId: session.id,
      conversationId: session.conversationId,
      realtimeTranscript,
      bufferedAudioBytes: bufferedAudio.length,
      message,
    })
  }

  appendFinalizePendingTrace(
    session: ActiveVoiceSession,
    realtimeTranscript: string,
    transcript: string,
    bufferedAudio: Buffer,
  ): void {
    appendVoiceTrace({
      type: 'finalize_pending_transcript',
      sessionId: session.id,
      conversationId: session.conversationId,
      realtimeTranscript,
      transcript,
      bufferedAudioBytes: bufferedAudio.length,
      clientTurnEnded: session.clientTurnEnded,
    })
  }

  appendDroppedFinalTrace(
    session: ActiveVoiceSession,
    transcript: string,
  ): void {
    appendVoiceTrace({
      type: 'stt_final_dropped_after_settle',
      sessionId: session.id,
      conversationId: session.conversationId,
      transcript,
      clientTurnEnded: session.clientTurnEnded,
    })
  }

  appendIgnoredFinalTrace(
    session: ActiveVoiceSession,
    transcript: string,
  ): void {
    appendVoiceTrace({
      type: 'stt_final_ignored_after_assistant_started',
      sessionId: session.id,
      conversationId: session.conversationId,
      transcript,
    })
  }

  appendSttFinalCandidateTrace(
    session: ActiveVoiceSession,
    transcript: string,
    chosenTranscript: string,
  ): void {
    appendVoiceTrace({
      type: 'stt_final_candidate',
      sessionId: session.id,
      conversationId: session.conversationId,
      transcript,
      chosenTranscript,
      clientTurnEnded: session.clientTurnEnded,
    })
  }

  appendIgnoredSttErrorTrace(
    session: ActiveVoiceSession,
    message: string,
    reason: string,
  ): void {
    appendVoiceTrace({
      type: 'stt_error_ignored',
      sessionId: session.id,
      conversationId: session.conversationId,
      message,
      reason,
      pendingFinalTranscript: session.pendingFinalTranscript,
      clientTurnEnded: session.clientTurnEnded,
    })
  }

  appendSttErrorTrace(
    session: ActiveVoiceSession,
    message: string,
  ): void {
    appendVoiceTrace({
      type: 'stt_error',
      sessionId: session.id,
      conversationId: session.conversationId,
      message,
    })
  }

  appendAssistantErrorTrace(
    session: ActiveVoiceSession,
    message: string,
  ): void {
    appendVoiceTrace({
      type: 'assistant_error',
      sessionId: session.id,
      conversationId: session.conversationId,
      transcript: session.finalTranscript,
      message,
    })
  }

  logTurnMetrics(session: ActiveVoiceSession): void {
    const sttMs =
      session.sttFinalAt != null ? session.sttFinalAt - session.startedAt : null

    const firstTextMs =
      session.assistantFirstDeltaAt != null && session.sttFinalAt != null
        ? session.assistantFirstDeltaAt - session.sttFinalAt
        : null

    const firstAudioMs =
      session.assistantFirstAudioAt != null && session.sttFinalAt != null
        ? session.assistantFirstAudioAt - session.sttFinalAt
        : null

    const completeMs =
      session.assistantFinalAt != null && session.sttFinalAt != null
        ? session.assistantFinalAt - session.sttFinalAt
        : null

    const totalMs = Date.now() - session.startedAt

    this.logger.log(
      `[TURN METRICS] ${session.id} ` +
      `stt=${sttMs ?? '-'}ms ` +
      `first_text=${firstTextMs ?? '-'}ms ` +
      `first_audio=${firstAudioMs ?? '-'}ms ` +
      `complete=${completeMs ?? '-'}ms ` +
      `total=${totalMs}ms ` +
      `chunks=${session.chunkCount} ` +
      `bufferedAudioBytes=${this.getBufferedAudio(session).length}`,
    )
  }

  private getBufferedAudio(session: ActiveVoiceSession): Buffer {
    return Buffer.concat(session.audioChunks)
  }
}
