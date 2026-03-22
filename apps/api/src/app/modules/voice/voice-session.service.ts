import { Injectable, Logger } from '@nestjs/common'
import { WebSocket } from 'ws'
import { randomUUID } from 'crypto'

import { VoiceSttService } from './voice-stt.service'
import type { StreamingSttEvent } from '@energrid/stt-stream-core'
import { VoiceAssistantReplyStreamerService } from './voice-assistant-reply-streamer.service'
import { VoiceSessionTraceService } from './voice-session-trace.service'
import { VoiceSessionEmitterService } from './voice-session-emitter.service'
import type { ActiveVoiceSession } from './voice-session.types'

@Injectable()
export class VoiceSessionService {
  private readonly logger = new Logger(VoiceSessionService.name)
  private readonly sessions = new Map<WebSocket, ActiveVoiceSession>()

  constructor(
    private readonly sttService: VoiceSttService,
    private readonly replyStreamer: VoiceAssistantReplyStreamerService,
    private readonly trace: VoiceSessionTraceService,
    private readonly emitter: VoiceSessionEmitterService,
  ) {}

  async openSession(client: WebSocket): Promise<void> {
    const session = await this.createSession(client)
    this.sessions.set(client, session)

    this.trace.logSessionStart(session)
    this.emitter.emitSessionStart(session)
  }

  async pushAudio(client: WebSocket, buf: Buffer): Promise<void> {
    const session = this.getSession(client)
    if (!session || session.turnEnded) return

    this.storeIncomingAudioChunk(session, buf)
    await session.sttSession.pushAudio(buf)
  }

  async endTurn(client: WebSocket): Promise<void> {
    const session = this.getSession(client)
    if (!session) return
    if (this.isTurnAlreadyClosed(session)) return

    this.markTurnEnded(session)
    await this.endSttInput(session)
    this.schedulePendingTranscriptFinalization(session, 250)
  }

  async closeSession(client: WebSocket): Promise<void> {
    const session = this.getSession(client)
    if (!session) return

    this.clearPendingFinalTimer(session)
    this.trace.logSessionEnd(session)
    await this.closeSttSession(session)
    this.trace.emitSessionEndDebug(session)
    this.trace.appendSessionEndTrace(session)

    this.sessions.delete(client)
  }

  private async createSession(client: WebSocket): Promise<ActiveVoiceSession> {
    const id = randomUUID()
    const conversationId = randomUUID()

    let session!: ActiveVoiceSession

    const sttSession = await this.sttService.createSession(
      async (event: StreamingSttEvent) => {
        try {
          await this.handleSttEvent(session, event)
        } catch (error) {
          this.handleVoiceEventError(session, error)
        }
      },
    )

    session = {
      id,
      conversationId,
      client,
      sttSession,

      chunkCount: 0,
      audioChunks: [],
      partialTranscript: '',
      finalTranscript: '',
      assistantReply: '',

      startedAt: Date.now(),
      lastChunkAt: Date.now(),

      turnEnded: false,
      clientTurnEnded: false,
      finalized: false,
      assistantStarted: false,

      pendingFinalTranscript: '',
      pendingFinalTimer: null,

      sttFinalAt: null,
      assistantFirstDeltaAt: null,
      assistantFirstAudioAt: null,
      assistantFinalAt: null,
    }

    return session
  }

  private getSession(client: WebSocket): ActiveVoiceSession | undefined {
    return this.sessions.get(client)
  }

  private handleVoiceEventError(
    session: ActiveVoiceSession,
    error: unknown,
  ): void {
    const message =
      error instanceof Error ? error.message : 'Unhandled STT event error'

    this.logger.error(
      `[VOICE EVENT ERROR] ${session.id} ${message}`,
      error instanceof Error ? error.stack : undefined,
    )

    this.emitter.emitError(session, message)
  }

  private isTurnAlreadyClosed(session: ActiveVoiceSession): boolean {
    if (session.turnEnded || session.finalized) {
      this.logger.log(
        `[TURN END IGNORED] ${session.id} conversation=${session.conversationId} already finalized`,
      )
      return true
    }

    return false
  }

  private markTurnEnded(session: ActiveVoiceSession): void {
    session.turnEnded = true
    session.clientTurnEnded = true

    this.logger.log(
      `[TURN END] ${session.id} conversation=${session.conversationId}`,
    )
  }

  private async endSttInput(session: ActiveVoiceSession): Promise<void> {
    try {
      await session.sttSession.endInput()
    } catch (error) {
      this.logger.warn(`STT endInput error: ${String(error)}`)
    }
  }

  private async closeSttSession(session: ActiveVoiceSession): Promise<void> {
    try {
      await session.sttSession.close()
    } catch (error) {
      this.logger.warn(`STT close error: ${String(error)}`)
    }
  }

  private storeIncomingAudioChunk(
    session: ActiveVoiceSession,
    buf: Buffer,
  ): void {
    session.chunkCount++
    session.audioChunks.push(Buffer.from(buf))
    session.lastChunkAt = Date.now()

    if (session.chunkCount === 1 || session.chunkCount % 10 === 0) {
      this.logger.log(
        `[CHUNK] ${session.id} count=${session.chunkCount} bytes=${buf.length}`,
      )
    }

    this.emitter.emitChunkDebug(session, buf.length)
  }

  private isMeaningfulTranscript(text: string): boolean {
    const t = text.trim()

    if (!t) return false
    if (t.length < 2) return false

    const fillers = new Set([
      'м',
      'мм',
      'мм.',
      'а',
      'а.',
      'ъ',
      'ъъ',
      'eh',
      'um',
      'uh',
    ])

    if (fillers.has(t.toLowerCase())) return false

    return /[A-Za-zА-Яа-я]/.test(t)
  }

  private chooseBetterTranscript(current: string, candidate: string): string {
    const currentMeaningful = this.isMeaningfulTranscript(current)
    const candidateMeaningful = this.isMeaningfulTranscript(candidate)

    if (!currentMeaningful && candidateMeaningful) {
      return candidate
    }

    if (currentMeaningful && !candidateMeaningful) {
      return current
    }

    if (candidate.length > current.length) {
      return candidate
    }

    return current
  }

  private getBufferedAudio(session: ActiveVoiceSession): Buffer {
    return Buffer.concat(session.audioChunks)
  }

  private clearPendingFinalTimer(session: ActiveVoiceSession): void {
    if (session.pendingFinalTimer) {
      clearTimeout(session.pendingFinalTimer)
      session.pendingFinalTimer = null
    }
  }

  private shouldSchedulePendingFinalization(
    session: ActiveVoiceSession,
  ): boolean {
    if (!this.isMeaningfulTranscript(session.pendingFinalTranscript)) {
      return false
    }

    if (session.assistantStarted) {
      return false
    }

    return true
  }

  private schedulePendingTranscriptFinalization(
    session: ActiveVoiceSession,
    delayMs: number,
  ): void {
    if (!this.shouldSchedulePendingFinalization(session)) {
      return
    }

    this.clearPendingFinalTimer(session)

    session.pendingFinalTimer = setTimeout(() => {
      void this.finalizePendingTranscript(session)
    }, delayMs)
  }

  private async resolveFinalTranscript(
    session: ActiveVoiceSession,
    bufferedAudio: Buffer,
    realtimeTranscript: string,
  ): Promise<string> {
    const sttServiceWithBatch = this.sttService as VoiceSttService & {
      transcribeBufferedAudio?: (audio: Buffer) => Promise<string>
    }

    if (!sttServiceWithBatch.transcribeBufferedAudio) {
      this.trace.appendBatchUnavailableTrace(
        session,
        realtimeTranscript,
        bufferedAudio,
      )
      return realtimeTranscript
    }

    try {
      const batchTranscriptRaw =
        await sttServiceWithBatch.transcribeBufferedAudio(bufferedAudio)
      const batchTranscript = (batchTranscriptRaw || '').trim()
      const chosenTranscript = this.chooseBetterTranscript(
        realtimeTranscript,
        batchTranscript,
      )

      this.trace.appendBatchResultTrace(
        session,
        realtimeTranscript,
        batchTranscript,
        chosenTranscript,
        bufferedAudio,
      )

      return chosenTranscript.trim()
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Batch transcription failed'

      this.logger.warn(
        `[BATCH TRANSCRIPTION FAILED] ${session.id} ${message}`,
      )

      this.trace.appendBatchErrorTrace(
        session,
        realtimeTranscript,
        bufferedAudio,
        message,
      )

      return realtimeTranscript
    }
  }

  private async handleSttEvent(
    session: ActiveVoiceSession,
    event: StreamingSttEvent,
  ): Promise<void> {
    switch (event.type) {
      case 'stt_partial':
        await this.handleSttPartial(session, event.text)
        return

      case 'stt_final':
        await this.handleSttFinalCandidate(session, event.text || '')
        return

      case 'stt_error':
        await this.handleSttError(session, event.message)
        return

      default:
        return
    }
  }

  private async handleSttPartial(
    session: ActiveVoiceSession,
    text: string,
  ): Promise<void> {
    if (session.assistantStarted) return

    session.partialTranscript += text
    this.logger.log(`[STT PARTIAL] ${session.id} ${text}`)
    this.emitter.emitSttPartial(session, text)
  }

  private async handleSttFinalCandidate(
    session: ActiveVoiceSession,
    rawText: string,
  ): Promise<void> {
    if (session.assistantStarted) {
      this.trace.appendIgnoredFinalTrace(session, rawText.trim())
      return
    }

    const transcript = rawText.trim()
    const bestTranscript = this.chooseBetterTranscript(
      session.pendingFinalTranscript,
      transcript,
    )

    session.pendingFinalTranscript = bestTranscript
    this.trace.appendSttFinalCandidateTrace(session, transcript, bestTranscript)
    this.schedulePendingTranscriptFinalization(session, 700)
  }

  private async handleSttError(
    session: ActiveVoiceSession,
    message: string,
  ): Promise<void> {
    const isBufferTooSmall =
      typeof message === 'string' && message.includes('buffer too small')

    const hasMeaningfulPendingTranscript =
      this.isMeaningfulTranscript(session.pendingFinalTranscript)

    const isLateEmptyCommit = session.finalized && isBufferTooSmall
    const shouldIgnorePendingCandidateError =
      !session.finalized && isBufferTooSmall && hasMeaningfulPendingTranscript

    if (isLateEmptyCommit || shouldIgnorePendingCandidateError) {
      const reason = isLateEmptyCommit
        ? 'late_empty_commit'
        : 'pending_candidate_preserved'

      this.logger.warn(
        `[STT ERROR IGNORED] ${session.id} reason=${reason} ${message}`,
      )

      this.trace.appendIgnoredSttErrorTrace(session, message, reason)
      return
    }

    this.logger.error(`[STT ERROR] ${session.id} ${message}`)
    this.trace.appendSttErrorTrace(session, message)
    this.emitter.emitError(session, message)
  }

  private async finalizePendingTranscript(
    session: ActiveVoiceSession,
  ): Promise<void> {
    if (session.assistantStarted) return

    if (!session.clientTurnEnded) {
      this.schedulePendingTranscriptFinalization(session, 250)
      return
    }

    this.clearPendingFinalTimer(session)

    const transcript = await this.resolveAndValidateFinalTranscript(session)
    if (!transcript) return

    this.markTranscriptFinalized(session, transcript)
    this.emitFinalTranscript(session)

    try {
      await this.generateAssistantReply(session)
      this.emitter.emitTurnEnd(session)
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Assistant generation failed'

      this.logger.error(
        `[ASSISTANT ERROR] ${session.id} ${message}`,
        error instanceof Error ? error.stack : undefined,
      )

      this.trace.appendAssistantErrorTrace(session, message)
      this.emitter.emitError(session, message)
    }
  }

  private async resolveAndValidateFinalTranscript(
    session: ActiveVoiceSession,
  ): Promise<string | null> {
    const realtimeTranscript = session.pendingFinalTranscript.trim()
    const bufferedAudio = this.getBufferedAudio(session)

    const transcript = await this.resolveFinalTranscript(
      session,
      bufferedAudio,
      realtimeTranscript,
    )

    this.trace.appendFinalizePendingTrace(
      session,
      realtimeTranscript,
      transcript,
      bufferedAudio,
    )

    if (!this.isMeaningfulTranscript(transcript)) {
      this.logger.warn(
        `[STT FINAL DROPPED AFTER SETTLE] ${session.id} ${JSON.stringify(transcript)}`,
      )

      this.trace.appendDroppedFinalTrace(session, transcript)
      this.emitter.emitTurnEnd(session)
      return null
    }

    return transcript
  }

  private markTranscriptFinalized(
    session: ActiveVoiceSession,
    transcript: string,
  ): void {
    session.assistantStarted = true
    session.finalized = true
    session.finalTranscript = transcript
    session.sttFinalAt = Date.now()

    this.logger.log(`[STT FINAL] ${session.id} ${session.finalTranscript}`)
    this.trace.appendSttFinalTrace(session)
  }

  private emitFinalTranscript(session: ActiveVoiceSession): void {
    this.emitter.emitSttFinal(session)
    this.trace.appendConversationInputTrace(session)
  }

  private async generateAssistantReply(
    session: ActiveVoiceSession,
  ): Promise<void> {
    const replyText = await this.replyStreamer.streamReply(
      {
        sessionId: session.id,
        conversationId: session.conversationId,
        transcript: session.finalTranscript,
      },
      {
        onTextDelta: (delta, fullText) => {
          this.markAssistantFirstDelta(session)
          this.emitter.emitAssistantTextDelta(session, delta, fullText)
          this.trace.appendAssistantTextDeltaTrace(session, delta, fullText)
        },

        onAudioChunk: ({ chunkIndex, isLastChunk, text, format, audioBuffer }) => {
          this.markAssistantFirstAudio(session)
          this.emitter.emitAssistantAudioChunk(session, {
            chunkIndex,
            isLastChunk,
            text,
            format,
            audioBuffer,
          })
        },

        onCompleted: (finalReplyText) => {
          session.assistantReply = finalReplyText
        },
      },
    )

    session.assistantReply = replyText
    session.assistantFinalAt = Date.now()

    this.logger.log(`[ASSISTANT] ${session.id} ${replyText}`)
    this.trace.appendAssistantFinalTrace(session)
    this.trace.logTurnMetrics(session)
    this.emitter.emitAssistantFinal(session)
  }

  private markAssistantFirstDelta(session: ActiveVoiceSession): void {
    if (!session.assistantFirstDeltaAt) {
      session.assistantFirstDeltaAt = Date.now()
    }
  }

  private markAssistantFirstAudio(session: ActiveVoiceSession): void {
    if (!session.assistantFirstAudioAt) {
      session.assistantFirstAudioAt = Date.now()
    }
  }
}
