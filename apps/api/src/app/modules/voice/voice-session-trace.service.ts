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
      metrics: this.buildTurnMetrics(session),
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

  appendAudioAnalysisTrace(session: ActiveVoiceSession): void {
    appendVoiceTrace({
      type: 'audio_analysis',
      sessionId: session.id,
      conversationId: session.conversationId,
      audioAnalysis: session.audioAnalysis,
      bufferedAudioBytes: this.getBufferedAudio(session).length,
    })
  }

  appendSpeechGateDroppedTrace(session: ActiveVoiceSession): void {
    appendVoiceTrace({
      type: 'speech_gate_dropped',
      sessionId: session.id,
      conversationId: session.conversationId,
      audioAnalysis: session.audioAnalysis,
      bufferedAudioBytes: this.getBufferedAudio(session).length,
    })

    this.debugEvents.emit({
      type: 'speech_gate_dropped',
      sessionId: session.id,
      conversationId: session.conversationId,
      audioAnalysis: session.audioAnalysis,
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
      sttFinalCandidateAt: session.sttFinalCandidateAt,
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
    const metrics = this.buildTurnMetrics(session)

    this.logger.log(
      `[TURN METRICS] ${session.id} ` +
      `upload=${metrics.uploadMs ?? '-'}ms ` +
      `stt=${metrics.sttMs ?? '-'}ms ` +
      `first_text=${metrics.firstTextMs ?? '-'}ms ` +
      `first_audio=${metrics.firstAudioMs ?? '-'}ms ` +
      `assistant=${metrics.assistantCompleteMs ?? '-'}ms ` +
      `total=${metrics.totalMs ?? '-'}ms ` +
      `chunks=${session.chunkCount} ` +
      `bufferedAudioBytes=${this.getBufferedAudio(session).length}`,
    )

    appendVoiceTrace({
      type: 'voice_metrics',
      sessionId: session.id,
      conversationId: session.conversationId,
      metrics,
    })

    this.debugEvents.emit({
      type: 'voice_metrics',
      sessionId: session.id,
      conversationId: session.conversationId,
      metrics,
    })
  }

  buildTurnMetrics(session: ActiveVoiceSession) {
    const now = Date.now()
    const bufferedAudioBytes = this.getBufferedAudio(session).length

    return {
      startedAt: session.startedAt,
      firstChunkAt: session.firstChunkAt,
      lastChunkAt: session.lastChunkAt,
      turnEndedAt: session.turnEndedAt,
      sttInputEndedAt: session.sttInputEndedAt,
      sttFinalCandidateAt: session.sttFinalCandidateAt,
      sttFinalAt: session.sttFinalAt,
      assistantFirstDeltaAt: session.assistantFirstDeltaAt,
      assistantFirstAudioAt: session.assistantFirstAudioAt,
      assistantFinalAt: session.assistantFinalAt,
      turnEndEmittedAt: session.turnEndEmittedAt,

      uploadMs:
        session.firstChunkAt != null && session.turnEndedAt != null
          ? session.turnEndedAt - session.firstChunkAt
          : null,
      endInputToSttCandidateMs:
        session.sttInputEndedAt != null && session.sttFinalCandidateAt != null
          ? session.sttFinalCandidateAt - session.sttInputEndedAt
          : null,
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
      totalMs:
        session.turnEndEmittedAt != null
          ? session.turnEndEmittedAt - session.startedAt
          : now - session.startedAt,

      chunkCount: session.chunkCount,
      bufferedAudioBytes,
      bufferedAudioMs: Math.round(bufferedAudioBytes / 2 / 16000 * 1000),
      audioAnalysis: session.audioAnalysis,
      speechGatePassed: session.audioAnalysis.speechGatePassed,
      transcriptChars: session.finalTranscript.length,
      assistantReplyChars: session.assistantReply.length,
      llmRequestToStreamMs:
        session.timings.llmRequestStartedAt != null &&
        session.timings.llmStreamCreatedAt != null
          ? session.timings.llmStreamCreatedAt -
            session.timings.llmRequestStartedAt
          : null,
      llmFirstDeltaMs:
        session.timings.llmRequestStartedAt != null &&
        session.timings.llmFirstDeltaAt != null
          ? session.timings.llmFirstDeltaAt -
            session.timings.llmRequestStartedAt
          : null,
      llmTotalMs:
        session.timings.llmRequestStartedAt != null &&
        session.timings.llmCompletedAt != null
          ? session.timings.llmCompletedAt -
            session.timings.llmRequestStartedAt
          : null,
      firstTtsWaitFromSttMs:
        session.sttFinalAt != null && session.timings.firstTtsRequestAt != null
          ? session.timings.firstTtsRequestAt - session.sttFinalAt
          : null,
      firstTtsDurationMs:
        session.timings.ttsChunk0DurationMs ?? null,
      ttsTotalMs:
        session.timings.firstTtsRequestAt != null &&
        session.timings.lastTtsCompletedAt != null
          ? session.timings.lastTtsCompletedAt -
            session.timings.firstTtsRequestAt
          : null,
      ttsChunkCount: session.timings.ttsChunkCount ?? 0,
      commandFastPath: session.counters.commandFastPath === 1,
      timings: session.timings,
    }
  }

  private getBufferedAudio(session: ActiveVoiceSession): Buffer {
    return Buffer.concat(session.audioChunks)
  }
}
