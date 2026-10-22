import { Inject, Injectable, Logger } from '@nestjs/common'
import {
  HOUSE_AGENT,
  type HouseAgentPort,
} from '../llm/house-agent.port'
import { DeviceRegistryService } from '../devices/device-registry.service'
import {
  InteractionTraceSession,
  type InteractionOutcome,
} from '../observability/interaction-trace'
import { FileInteractionTraceStore } from '../observability/file-interaction-trace.store'
import { runWithInteractionTrace } from '../observability/interaction-trace-context'
import { WebSocket } from 'ws'
import { randomUUID } from 'crypto'
import {
  classifyHomeIntent,
  planHomeIntent,
} from '@energrid/domain-automation'

import { VoiceSttService } from './voice-stt.service'
import type { StreamingSttEvent } from '@energrid/stt-stream-core'
import { VoiceAssistantReplyStreamerService } from './voice-assistant-reply-streamer.service'
import { VoiceSessionTraceService } from './voice-session-trace.service'
import { VoiceSessionEmitterService } from './voice-session-emitter.service'
import type { ActiveVoiceSession } from './voice-session.types'
import { HomeAutomationService } from './home-automation.service'

@Injectable()
export class VoiceSessionService {
  private readonly logger = new Logger(VoiceSessionService.name)

  // Property injection preserves the existing constructor and its tests.
  @Inject(HOUSE_AGENT)
  private readonly houseAgent!: HouseAgentPort

  @Inject(DeviceRegistryService)
  private readonly deviceRegistry!: DeviceRegistryService
  private readonly sessions = new Map<WebSocket, ActiveVoiceSession>()
  private readonly speechGateRmsDb = Number(
    process.env.VOICE_SPEECH_GATE_RMS_DB || -55,
  )
  private readonly speechGatePeakDb = Number(
    process.env.VOICE_SPEECH_GATE_PEAK_DB || -45,
  )
  private readonly maxAudioBytes = maximumVoiceAudioBytes()

  constructor(
    private readonly sttService: VoiceSttService,
    private readonly replyStreamer: VoiceAssistantReplyStreamerService,
    private readonly trace: VoiceSessionTraceService,
    private readonly emitter: VoiceSessionEmitterService,
    private readonly homeAutomation: HomeAutomationService,
  ) {}

  async openSession(client: WebSocket): Promise<void> {
    const session = await this.createSession(client)
    this.sessions.set(client, session)

    this.trace.logSessionStart(session)
    this.emitter.emitSessionStart(session)
  }

  async pushAudio(client: WebSocket, buf: Buffer): Promise<void> {
    const session = this.getSession(client)
    if (!session || session.turnEnded || session.sttFailed) return

    if (!this.storeIncomingAudioChunk(session, buf) || !session.streamingStt) return

    if (!session.sttStreamingStarted && !this.analyzePcm16Audio(buf).speechGatePassed) return
    session.sttStreamingStarted = true
    const next = session.sttPushQueue.then(() => this.pushPendingSttAudio(session))
    session.sttPushQueue = next
    await next
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

  async confirmPendingAction(client: WebSocket, approvalId: unknown): Promise<void> {
    const session = this.getSession(client)
    const pending = session?.pendingActionApproval
    if (!session || !pending || typeof approvalId !== 'string' || pending.id !== approvalId) {
      this.emitter.emitActionConfirmationResult(session, 'unavailable')
      return
    }

    this.clearPendingActionApproval(session)
    if (pending.expiresAt <= Date.now()) {
      this.emitter.emitActionConfirmationResult(session, 'expired')
      return
    }

    try {
      const results = await this.homeAutomation.executePlan(pending.plan)
      session.homeActionExecutionResults = results
      this.emitter.emitHomeActionExecution(session, results)
      this.emitter.emitActionConfirmationResult(session, 'completed', results)
    } catch {
      this.emitter.emitActionConfirmationResult(session, 'failed')
    }
  }

  cancelPendingAction(client: WebSocket, approvalId: unknown): void {
    const session = this.getSession(client)
    const pending = session?.pendingActionApproval
    if (!session || !pending || typeof approvalId !== 'string' || pending.id !== approvalId) {
      this.emitter.emitActionConfirmationResult(session, 'unavailable')
      return
    }

    this.clearPendingActionApproval(session)
    this.emitter.emitActionConfirmationResult(session, 'cancelled')
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
      streamingStt: this.sttService.isStreamingMode(),
      sttStreamingStarted: false,
      sttPushedChunkCount: 0,
      sttFailed: false,
      sttPushQueue: Promise.resolve(),

      chunkCount: 0,
      bufferedAudioBytes: 0,
      audioChunks: [],
      partialTranscript: '',
      finalTranscript: '',
      assistantReply: '',
      homeIntentClassification: null,
      homeIntentPlan: null,
      homeActionExecutionResults: [],
      pendingActionApproval: null,
      errorMessages: [],

      startedAt: Date.now(),
      firstChunkAt: null,
      lastChunkAt: Date.now(),
      turnEndedAt: null,
      sttInputEndedAt: null,

      turnEnded: false,
      clientTurnEnded: false,
      finalized: false,
      assistantStarted: false,

      pendingFinalTranscript: '',
      pendingFinalTimer: null,

      sttFinalCandidateAt: null,
      sttFinalAt: null,
      assistantFirstDeltaAt: null,
      assistantFirstAudioAt: null,
      assistantFinalAt: null,
      turnEndEmittedAt: null,
      timings: {},
      counters: {},
      audioAnalysis: {
        rmsDb: null,
        peakDb: null,
        rms: 0,
        peak: 0,
        sampleCount: 0,
        speechGatePassed: null,
      },
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
    session.errorMessages.push(message)
    session.sttFailed = true

    this.logger.error(
      `[VOICE EVENT ERROR] ${session.id} ${message}`,
      error instanceof Error ? error.stack : undefined,
    )

    this.emitter.emitError(session, 'Voice processing failed. Please try again.')
    void this.closeSttSession(session)
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
    session.turnEndedAt = Date.now()

    this.logger.log(
      `[TURN END] ${session.id} conversation=${session.conversationId}`,
    )
  }

  private async endSttInput(session: ActiveVoiceSession): Promise<void> {
    try {
      const audio = this.getBufferedAudio(session)
      const analysis = this.analyzePcm16Audio(audio)
      session.audioAnalysis = analysis

      this.trace.appendAudioAnalysisTrace(session)

      if (!analysis.speechGatePassed) {
        this.logger.warn(
          `[SPEECH GATE DROPPED] ${session.id} rmsDb=${analysis.rmsDb ?? '-'} peakDb=${analysis.peakDb ?? '-'} samples=${analysis.sampleCount}`,
        )
        this.trace.appendSpeechGateDroppedTrace(session)
        this.emitter.emitTurnEnd(session)
        this.trace.recordCompletedTurn(session)
        return
      }

      if (session.sttFailed) {
        this.emitter.emitTurnEnd(session)
        this.trace.recordCompletedTurn(session)
        return
      }

      session.sttInputEndedAt = Date.now()
      await session.sttPushQueue
      if (session.sttFailed) {
        this.emitter.emitTurnEnd(session)
        this.trace.recordCompletedTurn(session)
        return
      }
      await this.pushPendingSttAudio(session)
      if (session.sttFailed) {
        this.emitter.emitTurnEnd(session)
        this.trace.recordCompletedTurn(session)
        return
      }
      await session.sttSession.endInput()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.warn(`STT endInput error: ${message}`)
      this.emitter.emitError(session, 'Speech recognition could not finish this turn.')
      this.emitter.emitTurnEnd(session)
      this.trace.recordCompletedTurn(session)
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
  ): boolean {
    if (session.bufferedAudioBytes + buf.length > this.maxAudioBytes) {
      this.emitter.emitError(
        session,
        'Voice turn exceeded the maximum audio size. Please try a shorter request.',
      )
      session.client.close(1009, 'Voice turn too large')
      return false
    }

    session.chunkCount++
    session.audioChunks.push(Buffer.from(buf))
    session.bufferedAudioBytes += buf.length
    session.firstChunkAt ??= Date.now()
    session.lastChunkAt = Date.now()

    if (session.chunkCount === 1 || session.chunkCount % 10 === 0) {
      this.logger.log(
        `[CHUNK] ${session.id} count=${session.chunkCount} bytes=${buf.length}`,
      )
    }

    this.emitter.emitChunkDebug(session, buf.length)
    return true
  }

  private async pushPendingSttAudio(session: ActiveVoiceSession): Promise<void> {
    while (
      !session.sttFailed &&
      session.sttPushedChunkCount < session.audioChunks.length
    ) {
      const chunk = session.audioChunks[session.sttPushedChunkCount]
      try {
        await session.sttSession.pushAudio(chunk)
        session.sttPushedChunkCount++
      } catch (error) {
        if (!session.sttFailed) {
          session.sttFailed = true
          this.handleVoiceEventError(session, error)
        }
        await this.closeSttSession(session)
        return
      }
    }
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

  private analyzePcm16Audio(audio: Buffer): ActiveVoiceSession['audioAnalysis'] {
    const sampleCount = Math.floor(audio.length / 2)

    if (!sampleCount) {
      return {
        rmsDb: null,
        peakDb: null,
        rms: 0,
        peak: 0,
        sampleCount: 0,
        speechGatePassed: false,
      }
    }

    let sumSquares = 0
    let peak = 0

    for (let offset = 0; offset + 1 < audio.length; offset += 2) {
      const normalized = audio.readInt16LE(offset) / 32768
      const abs = Math.abs(normalized)
      sumSquares += normalized * normalized
      if (abs > peak) peak = abs
    }

    const rms = Math.sqrt(sumSquares / sampleCount)
    const rmsDb = this.toDb(rms)
    const peakDb = this.toDb(peak)

    return {
      rmsDb,
      peakDb,
      rms,
      peak,
      sampleCount,
      speechGatePassed:
        rmsDb >= this.speechGateRmsDb || peakDb >= this.speechGatePeakDb,
    }
  }

  private toDb(value: number): number {
    if (value <= 0) return -120
    return Math.round(20 * Math.log10(value) * 10) / 10
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
    this.clearPendingActionApproval(session)

    session.pendingFinalTimer = setTimeout(() => {
      void this.finalizePendingTranscript(session)
    }, delayMs)
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
        await this.handleSttError(session, event.message, event.diagnostic)
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
    this.logger.log(`[STT PARTIAL] ${session.id} chars=${text.length}`)
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
    session.sttFinalCandidateAt = Date.now()
    this.trace.appendSttFinalCandidateTrace(session, transcript, bestTranscript)

    if (session.clientTurnEnded) {
      await this.finalizePendingTranscript(session)
      return
    }

    this.schedulePendingTranscriptFinalization(session, 700)
  }

  private async handleSttError(
    session: ActiveVoiceSession,
    message: string,
    diagnostic?: Extract<StreamingSttEvent, { type: 'stt_error' }>['diagnostic'],
  ): Promise<void> {
    if (session.sttFailed) return

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

    session.sttFailed = true
    this.logger.error(`[STT ERROR] ${session.id} ${message}`)
    const safeDiagnostic = sanitizeSttDiagnostic(diagnostic)
    const diagnosticText = formatSttDiagnostic(safeDiagnostic)
    if (diagnosticText) {
      this.logger.error(`[STT PROVIDER DIAGNOSTIC] ${session.id} ${diagnosticText}`)
    }
    this.trace.appendSttErrorTrace(session, message, safeDiagnostic)
    this.emitter.emitError(session, 'Speech recognition failed. Please try again.')
    await this.closeSttSession(session)
    if (session.clientTurnEnded && !hasMeaningfulPendingTranscript) {
      session.finalized = true
      this.emitter.emitTurnEnd(session)
      this.trace.recordCompletedTurn(session)
    }
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
      this.trace.recordCompletedTurn(session)
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Assistant generation failed'
      session.errorMessages.push(message)

      this.logger.error(
        `[ASSISTANT ERROR] ${session.id} ${message}`,
        error instanceof Error ? error.stack : undefined,
      )

      this.trace.appendAssistantErrorTrace(session, message)
      this.emitter.emitError(session, 'The assistant could not complete this turn.')
      this.emitter.emitTurnEnd(session)
      this.trace.recordCompletedTurn(session)
    }
  }

  private async resolveAndValidateFinalTranscript(
    session: ActiveVoiceSession,
  ): Promise<string | null> {
    const transcript = session.pendingFinalTranscript.trim()
    const bufferedAudio = this.getBufferedAudio(session)

    this.trace.appendFinalizePendingTrace(
      session,
      transcript,
      transcript,
      bufferedAudio,
    )

    if (!this.isMeaningfulTranscript(transcript)) {
      this.logger.warn(
        `[STT FINAL DROPPED AFTER SETTLE] ${session.id} chars=${transcript.length}`,
      )

      this.trace.appendDroppedFinalTrace(session, transcript)
      this.emitter.emitTurnEnd(session)
      this.trace.recordCompletedTurn(session)
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

    this.logger.log(
      `[STT FINAL] ${session.id} chars=${session.finalTranscript.length}`,
    )
    this.trace.appendSttFinalTrace(session)
  }

  private emitFinalTranscript(session: ActiveVoiceSession): void {
    this.emitter.emitSttFinal(session)
    this.trace.appendConversationInputTrace(session)
  }

  private async generateAssistantReply(
    session: ActiveVoiceSession,
  ): Promise<void> {
    if (process.env.VOICE_ASSISTANT_PROVIDER === 'letta') {
      await this.generateLettaReply(session)
      return
    }

    const automationHandled = await this.tryGenerateAutomationReply(session)
    if (automationHandled) return

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

        onMetrics: (metrics) => {
          Object.assign(session.timings, metrics)
        },
      },
    )

    session.assistantReply = replyText
    session.assistantFinalAt = Date.now()

    this.logger.log(`[ASSISTANT] ${session.id} replyChars=${replyText.length}`)
    this.trace.appendAssistantFinalTrace(session)
    this.trace.logTurnMetrics(session)
    this.emitter.emitAssistantFinal(session)
  }

  private async generateLettaReply(
    session: ActiveVoiceSession,
  ): Promise<void> {
    // Derive scope from the installation, not from STT or model output.
    const { tenant, site } = this.deviceRegistry.getSnapshot()

    if (!tenant?.id || !site?.id) {
      throw new Error('Voice assistant installation scope is unavailable')
    }

    const scope = {
      tenantId: tenant.id,
      siteId: site.id,
    }

    const interaction = new InteractionTraceSession(
      scope,
      'voice',
      new FileInteractionTraceStore(),
    )

    let outcome: InteractionOutcome = 'failed'

    try {
      await runWithInteractionTrace(interaction, async () => {
        session.timings.llmRequestStartedAt = Date.now()

        // This is the same scoped HouseAgentPort used by text chat.
        // Do not call the legacy automation planner in this mode.
        const answer = await interaction.measure(
          'assistant.turn',
          () => this.houseAgent.talk(
            scope,
            session.finalTranscript,
          ),
        )

        session.timings.llmCompletedAt = Date.now()
        session.timings.llmFirstDeltaAt =
          session.timings.llmCompletedAt

        // Reuse the existing voice streaming and Bulgarian TTS.
        // This stage includes text emission and speech generation.
        const replyText = await interaction.measure(
          'assistant.respond',
          () => this.replyStreamer.streamStaticReply(
            {
              sessionId: session.id,
              conversationId: session.conversationId,
              transcript: session.finalTranscript,
              replyText: answer.text,
            },
            {
              onTextDelta: (delta, fullText) => {
                this.markAssistantFirstDelta(session)
                this.emitter.emitAssistantTextDelta(
                  session,
                  delta,
                  fullText,
                )
                this.trace.appendAssistantTextDeltaTrace(
                  session,
                  delta,
                  fullText,
                )
              },

              onAudioChunk: ({
                chunkIndex,
                isLastChunk,
                text,
                format,
                audioBuffer,
              }) => {
                this.markAssistantFirstAudio(session)
                this.emitter.emitAssistantAudioChunk(session, {
                  chunkIndex,
                  isLastChunk,
                  text,
                  format,
                  audioBuffer,
                })
              },

              onCompleted: finalReplyText => {
                session.assistantReply = finalReplyText
              },

              onMetrics: metrics => {
                Object.assign(session.timings, metrics)
              },
            },
          ),
        )

        session.assistantReply = replyText
        session.assistantFinalAt = Date.now()

        this.logger.log(
          '[VOICE LETTA] ' +
          'session=' + session.id +
          ' trace=' + interaction.traceId +
          ' replyChars=' + replyText.length,
        )

        this.trace.appendAssistantFinalTrace(session)
        this.trace.logTurnMetrics(session)
        this.emitter.emitAssistantFinal(session)
      })

      outcome = interaction.suggestedOutcome ?? 'succeeded'
    } finally {
      try {
        await interaction.finish(outcome)
      } catch {
        // Never override an assistant result or hardware outcome
        // because diagnostic persistence failed.
        this.logger.warn(
          'Voice interaction trace persistence failed',
        )
      }
    }
  }

  private async tryGenerateAutomationReply(
    session: ActiveVoiceSession,
  ): Promise<boolean> {
    const classification = classifyHomeIntent(session.finalTranscript)
    session.homeIntentClassification = classification

    if (classification.intent === 'unknown') {
      return false
    }

    session.counters.commandFastPath = 1
    session.timings.llmRequestStartedAt = Date.now()
    session.timings.llmFirstDeltaAt = session.timings.llmRequestStartedAt
    session.timings.llmCompletedAt = session.timings.llmRequestStartedAt

    const homeContext = await this.homeAutomation.getHomeContext()
    const plan = planHomeIntent({
      intent: classification.intent,
      context: {
        ...homeContext,
        requestedText: session.finalTranscript,
      },
    })
    session.homeIntentPlan = plan

    this.emitter.emitHomeActionPlan(session, classification, plan)

    const containsDeviceAction = plan.actions.some(
      (action) => action.type !== 'status.report',
    )
    const executionResults = plan.requiresConfirmation || containsDeviceAction
      ? []
      : await this.homeAutomation.executePlan(plan)
    session.homeActionExecutionResults = executionResults

    if (executionResults.length > 0) {
      this.emitter.emitHomeActionExecution(session, executionResults)
    }

    const replyTextWithExecution = containsDeviceAction
      ? this.requestActionApproval(session, plan)
      : this.withExecutionSummary(plan.spokenReply, executionResults)

    const replyText = await this.replyStreamer.streamStaticReply(
      {
        sessionId: session.id,
        conversationId: session.conversationId,
        transcript: session.finalTranscript,
        replyText: replyTextWithExecution,
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

        onMetrics: (metrics) => {
          Object.assign(session.timings, metrics)
        },
      },
    )

    session.assistantReply = replyText
    session.assistantFinalAt = Date.now()

    this.logger.log(
      `[HOME ACTION PLAN] ${session.id} intent=${classification.intent} actions=${plan.actions.length}`,
    )
    this.trace.appendAssistantFinalTrace(session)
    this.trace.logTurnMetrics(session)
    this.emitter.emitAssistantFinal(session)

    return true
  }

  private requestActionApproval(
    session: ActiveVoiceSession,
    plan: NonNullable<ActiveVoiceSession['homeIntentPlan']>,
  ): string {
    this.clearPendingActionApproval(session)
    const id = randomUUID()
    const expiresAt = Date.now() + actionApprovalWindowMs()
    const timer = setTimeout(() => {
      if (session.pendingActionApproval?.id !== id) return
      this.clearPendingActionApproval(session)
      this.emitter.emitActionConfirmationResult(session, 'expired')
    }, expiresAt - Date.now())
    session.pendingActionApproval = { id, plan, expiresAt, timer }
    this.emitter.emitActionConfirmationRequired(session, id, expiresAt, plan)
    return 'Разбрах заявката. Прегледайте точното действие на екрана и натиснете „Потвърди“, за да го изпълня. Потвърждението изтича след кратко време.'
  }

  private clearPendingActionApproval(session: ActiveVoiceSession): void {
    if (!session.pendingActionApproval) return
    clearTimeout(session.pendingActionApproval.timer)
    session.pendingActionApproval = null
  }

  private withExecutionSummary(
    spokenReply: string,
    executionResults: Awaited<ReturnType<HomeAutomationService['executePlan']>>,
  ): string {
    if (executionResults.length === 0) return spokenReply

    const failed = executionResults.filter((result) => result.status === 'failed')
    if (failed.length > 0) {
      return `${spokenReply} Но имаше проблем при изпълнението: ${failed[0].message}`
    }

    const pending = executionResults.filter(
      (result) => result.status === 'pending',
    )
    if (pending.length > 0) {
      return `${spokenReply} Командата е изпратена, но все още чакам потвърждение от устройството.`
    }

    const simulated = executionResults.filter(
      (result) => result.adapter === 'simulated',
    )
    if (simulated.length > 0) {
      return `${spokenReply} Това беше изпълнено само в симулация.`
    }

    const skipped = executionResults.find((result) => result.status === 'skipped')
    if (skipped) {
      return `${spokenReply} Част от плана не беше изпълнена: ${skipped.message}`
    }

    const executed = executionResults.filter((result) => result.status === 'success')
    if (executed.length > 0) return spokenReply

    return spokenReply
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

function maximumVoiceAudioBytes(): number {
  const configured = Number(process.env.VOICE_MAX_AUDIO_BYTES)
  if (!Number.isFinite(configured)) return 1_536_000
  return Math.max(32_000, Math.min(5_000_000, Math.floor(configured)))
}

function actionApprovalWindowMs(): number {
  const configured = Number(process.env.VOICE_ACTION_APPROVAL_MS)
  if (!Number.isFinite(configured)) return 15_000
  return Math.max(5_000, Math.min(60_000, Math.floor(configured)))
}

function formatSttDiagnostic(
  diagnostic?: Extract<StreamingSttEvent, { type: 'stt_error' }>['diagnostic'],
): string {
  if (!diagnostic) return ''
  return Object.entries(diagnostic)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ')
}

function sanitizeSttDiagnostic(
  diagnostic?: Extract<StreamingSttEvent, { type: 'stt_error' }>['diagnostic'],
): Extract<StreamingSttEvent, { type: 'stt_error' }>['diagnostic'] {
  if (!diagnostic) return undefined
  const safe: NonNullable<Extract<StreamingSttEvent, { type: 'stt_error' }>['diagnostic']> = {}
  for (const key of ['providerEvent', 'providerCode', 'providerType', 'providerParam'] as const) {
    const value = diagnostic[key]
    if (typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(value)) {
      safe[key] = value
    }
  }
  if (typeof diagnostic.closeCode === 'number' && Number.isInteger(diagnostic.closeCode)) {
    safe.closeCode = diagnostic.closeCode
  }
  return Object.keys(safe).length ? safe : undefined
}
