import { Injectable, Logger } from '@nestjs/common'
import { WebSocket } from 'ws'
import { randomUUID } from 'crypto'

import { appendVoiceTrace } from './utils/voice-trace.util'
import { VoiceSttService } from './voice-stt.service'
import { DebugEventsService } from './debug-events.service'
import { VoiceConversationService } from './voice-conversation.service'
import { VoiceSynthesisService } from './voice-synthesis.service'
import type {
  StreamingSttEvent,
  StreamingSttSession,
} from '@energrid/stt-stream-core'

interface ActiveVoiceSession {
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
}

@Injectable()
export class VoiceSessionService {
  private readonly logger = new Logger(VoiceSessionService.name)
  private readonly sessions = new Map<WebSocket, ActiveVoiceSession>()

  constructor(
    private readonly sttService: VoiceSttService,
    private readonly debugEvents: DebugEventsService,
    private readonly conversationService: VoiceConversationService,
    private readonly synthesisService: VoiceSynthesisService,
  ) {}

  private sendToClient(
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

  private emitToBoth(
    session: ActiveVoiceSession,
    clientEvent: Record<string, unknown>,
    debugEvent?: Record<string, unknown>,
  ): void {
    this.sendToClient(session, clientEvent)
    this.debugEvents.emit(debugEvent ?? clientEvent)
  }

  async openSession(client: WebSocket): Promise<void> {
    const id = randomUUID()
    const conversationId = randomUUID()

    this.logger.log(`[SESSION START] ${id} conversation=${conversationId}`)

    appendVoiceTrace({
      type: 'session_start',
      sessionId: id,
      conversationId,
    })

    let session!: ActiveVoiceSession

    const sttSession = await this.sttService.createSession(
      async (event: StreamingSttEvent) => {
        try {
          await this.handleSttEvent(session, event)
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'Unhandled STT event error'

          this.logger.error(
            `[VOICE EVENT ERROR] ${session?.id ?? 'unknown'} ${message}`,
            error instanceof Error ? error.stack : undefined,
          )

          if (session) {
            this.emitToBoth(session, {
              type: 'error',
              sessionId: session.id,
              message,
            })
          }
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
    }

    this.sessions.set(client, session)

    this.emitToBoth(session, {
      type: 'session_start',
      sessionId: id,
      conversationId,
    })
  }

  async pushAudio(client: WebSocket, buf: Buffer): Promise<void> {
    const session = this.sessions.get(client)
    if (!session) return
    if (session.turnEnded) return

    session.chunkCount++
    session.audioChunks.push(Buffer.from(buf))
    session.lastChunkAt = Date.now()

    if (session.chunkCount === 1 || session.chunkCount % 10 === 0) {
      this.logger.log(
        `[CHUNK] ${session.id} count=${session.chunkCount} bytes=${buf.length}`,
      )
    }

    this.debugEvents.emit({
      type: 'chunk',
      sessionId: session.id,
      chunkCount: session.chunkCount,
      bytes: buf.length,
    })

    await session.sttSession.pushAudio(buf)
  }

  async endTurn(client: WebSocket): Promise<void> {
    const session = this.sessions.get(client)
    if (!session) return

    if (session.turnEnded || session.finalized) {
      this.logger.log(
        `[TURN END IGNORED] ${session.id} conversation=${session.conversationId} already finalized`,
      )
      return
    }

    session.turnEnded = true
    session.clientTurnEnded = true

    this.logger.log(
      `[TURN END] ${session.id} conversation=${session.conversationId}`,
    )

    try {
      await session.sttSession.endInput()
    } catch (e) {
      this.logger.warn(`STT endInput error: ${String(e)}`)
    }

    if (
      this.isMeaningfulTranscript(session.pendingFinalTranscript) &&
      !session.assistantStarted
    ) {
      this.clearPendingFinalTimer(session)

      session.pendingFinalTimer = setTimeout(() => {
        void this.finalizePendingTranscript(session)
      }, 250)
    }
  }

  async closeSession(client: WebSocket): Promise<void> {
    const session = this.sessions.get(client)
    if (!session) return

    this.clearPendingFinalTimer(session)

    this.logger.log(
      `[SESSION END] ${session.id} conversation=${session.conversationId} transcript="${session.finalTranscript}"`,
    )

    try {
      await session.sttSession.close()
    } catch (e) {
      this.logger.warn(`STT close error: ${String(e)}`)
    }

    this.debugEvents.emit({
      type: 'session_end',
      sessionId: session.id,
      conversationId: session.conversationId,
      totalChunks: session.chunkCount,
      finalTranscript: session.finalTranscript.trim(),
      assistantReply: session.assistantReply,
      durationMs: Date.now() - session.startedAt,
    })

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

    this.sessions.delete(client)
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

  private async resolveFinalTranscript(
    session: ActiveVoiceSession,
    bufferedAudio: Buffer,
    realtimeTranscript: string,
  ): Promise<string> {
    const sttServiceWithBatch = this.sttService as VoiceSttService & {
      transcribeBufferedAudio?: (audio: Buffer) => Promise<string>
    }

    if (!sttServiceWithBatch.transcribeBufferedAudio) {
      appendVoiceTrace({
        type: 'batch_transcription_unavailable',
        sessionId: session.id,
        conversationId: session.conversationId,
        realtimeTranscript,
        bufferedAudioBytes: bufferedAudio.length,
      })

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

      appendVoiceTrace({
        type: 'batch_transcription_result',
        sessionId: session.id,
        conversationId: session.conversationId,
        realtimeTranscript,
        batchTranscript,
        chosenTranscript,
        bufferedAudioBytes: bufferedAudio.length,
      })

      return chosenTranscript.trim()
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Batch transcription failed'

      this.logger.warn(
        `[BATCH TRANSCRIPTION FAILED] ${session.id} ${message}`,
      )

      appendVoiceTrace({
        type: 'batch_transcription_error',
        sessionId: session.id,
        conversationId: session.conversationId,
        realtimeTranscript,
        bufferedAudioBytes: bufferedAudio.length,
        message,
      })

      return realtimeTranscript
    }
  }

  private async sendAssistantAudioChunks(
    session: ActiveVoiceSession,
    replyText: string,
  ): Promise<void> {
    const synthesizedChunks =
      await this.synthesisService.synthesizeChunks(replyText)

    for (let i = 0; i < synthesizedChunks.length; i++) {
      const synthesized = synthesizedChunks[i]
      const isLastChunk = i === synthesizedChunks.length - 1

      this.sendToClient(session, {
        type: 'assistant_audio_chunk',
        sessionId: session.id,
        format: synthesized.format,
        chunkIndex: i,
        isLastChunk,
        audioBase64: synthesized.audioBuffer.toString('base64'),
      })

      this.debugEvents.emit({
        type: 'assistant_audio_chunk',
        sessionId: session.id,
        format: synthesized.format,
        bytes: synthesized.audioBuffer.length,
        chunkIndex: i,
        isLastChunk,
      })

      appendVoiceTrace({
        type: 'assistant_audio_chunk',
        sessionId: session.id,
        conversationId: session.conversationId,
        bytes: synthesized.audioBuffer.length,
        chunkIndex: i,
        isLastChunk,
        assistantAudioAt: Date.now(),
      })
    }
  }

  private async finalizePendingTranscript(
    session: ActiveVoiceSession,
  ): Promise<void> {
    if (session.assistantStarted) {
      return
    }

    if (!session.clientTurnEnded) {
      this.clearPendingFinalTimer(session)

      session.pendingFinalTimer = setTimeout(() => {
        void this.finalizePendingTranscript(session)
      }, 250)
      return
    }

    this.clearPendingFinalTimer(session)

    const realtimeTranscript = session.pendingFinalTranscript.trim()
    const bufferedAudio = this.getBufferedAudio(session)
    const transcript = await this.resolveFinalTranscript(
      session,
      bufferedAudio,
      realtimeTranscript,
    )

    appendVoiceTrace({
      type: 'finalize_pending_transcript',
      sessionId: session.id,
      conversationId: session.conversationId,
      realtimeTranscript,
      transcript,
      bufferedAudioBytes: bufferedAudio.length,
      clientTurnEnded: session.clientTurnEnded,
    })

    if (!this.isMeaningfulTranscript(transcript)) {
      this.logger.warn(
        `[STT FINAL DROPPED AFTER SETTLE] ${session.id} ${JSON.stringify(transcript)}`,
      )

      appendVoiceTrace({
        type: 'stt_final_dropped_after_settle',
        sessionId: session.id,
        conversationId: session.conversationId,
        transcript,
        clientTurnEnded: session.clientTurnEnded,
      })

      this.emitToBoth(session, {
        type: 'turn_end',
        sessionId: session.id,
      })

      return
    }

    session.assistantStarted = true
    session.finalized = true
    session.finalTranscript = transcript

    this.logger.log(`[STT FINAL] ${session.id} ${session.finalTranscript}`)

    appendVoiceTrace({
      type: 'stt_final',
      sessionId: session.id,
      conversationId: session.conversationId,
      transcript: session.finalTranscript,
      chunkCount: session.chunkCount,
      startedAt: session.startedAt,
      sttFinalAt: Date.now(),
    })

    this.emitToBoth(session, {
      type: 'stt_final',
      sessionId: session.id,
      text: session.finalTranscript,
      full: session.finalTranscript,
    })

    appendVoiceTrace({
      type: 'conversation_input',
      sessionId: session.id,
      conversationId: session.conversationId,
      transcript: session.finalTranscript,
    })

    try {
      let streamedReply = ''
      let speakableBuffer = ''
      let audioChunkIndex = 0

      const flushStableChunks = async (forceFinal: boolean): Promise<void> => {
        while (true) {
          const { chunk, remainder } = this.extractSpeakableChunk(speakableBuffer)

          if (!chunk) {
            if (forceFinal) {
              const finalChunk = speakableBuffer.trim()
              if (finalChunk) {
                speakableBuffer = ''
                await this.sendAssistantAudioChunkFromText(
                  session,
                  finalChunk,
                  audioChunkIndex++,
                  true,
                )
              }
            }
            break
          }

          speakableBuffer = remainder
          const isLastChunk = forceFinal && !speakableBuffer.trim()

          await this.sendAssistantAudioChunkFromText(
            session,
            chunk,
            audioChunkIndex++,
            isLastChunk,
          )
        }
      }

      const result = await this.conversationService.handleFinalTranscriptStream(
        {
          conversationId: session.conversationId,
          sessionId: session.id,
          transcript: session.finalTranscript,
        },
        {
          onTextDelta: async (delta: string) => {
            streamedReply += delta
            speakableBuffer += delta

            this.sendToClient(session, {
              type: 'assistant_text_delta',
              sessionId: session.id,
              delta,
              full: streamedReply,
            })

            appendVoiceTrace({
              type: 'assistant_text_delta',
              sessionId: session.id,
              conversationId: session.conversationId,
              delta,
              accumulatedLength: streamedReply.length,
            })

            await flushStableChunks(false)
          },

          onCompletedText: async (fullText: string) => {
            streamedReply = fullText
            await flushStableChunks(true)
          },
        },
      )

      session.assistantReply = result.replyText

      this.logger.log(`[ASSISTANT] ${session.id} ${result.replyText}`)

      appendVoiceTrace({
        type: 'assistant_final',
        sessionId: session.id,
        conversationId: session.conversationId,
        transcript: session.finalTranscript,
        assistantReply: session.assistantReply,
        assistantFinalAt: Date.now(),
      })

      this.emitToBoth(session, {
        type: 'assistant_final',
        sessionId: session.id,
        text: result.replyText,
      })

      this.emitToBoth(session, {
        type: 'turn_end',
        sessionId: session.id,
      })
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Assistant generation failed'

      this.logger.error(
        `[ASSISTANT ERROR] ${session.id} ${message}`,
        error instanceof Error ? error.stack : undefined,
      )

      appendVoiceTrace({
        type: 'assistant_error',
        sessionId: session.id,
        conversationId: session.conversationId,
        transcript: session.finalTranscript,
        message,
      })

      this.emitToBoth(session, {
        type: 'error',
        sessionId: session.id,
        message,
      })
    }
  }

  private async handleSttEvent(
    session: ActiveVoiceSession,
    event: StreamingSttEvent,
  ): Promise<void> {
    if (event.type === 'stt_partial') {
      if (session.assistantStarted) {
        return
      }

      session.partialTranscript += event.text

      this.logger.log(`[STT PARTIAL] ${session.id} ${event.text}`)

      this.emitToBoth(session, {
        type: 'stt_partial',
        sessionId: session.id,
        text: event.text,
        full: session.partialTranscript,
      })

      return
    }

    if (event.type === 'stt_final') {
      if (session.assistantStarted) {
        appendVoiceTrace({
          type: 'stt_final_ignored_after_assistant_started',
          sessionId: session.id,
          conversationId: session.conversationId,
          transcript: (event.text || '').trim(),
        })
        return
      }

      const transcript = (event.text || '').trim()
      const bestTranscript = this.chooseBetterTranscript(
        session.pendingFinalTranscript,
        transcript,
      )

      session.pendingFinalTranscript = bestTranscript

      appendVoiceTrace({
        type: 'stt_final_candidate',
        sessionId: session.id,
        conversationId: session.conversationId,
        transcript,
        chosenTranscript: bestTranscript,
        clientTurnEnded: session.clientTurnEnded,
      })

      this.clearPendingFinalTimer(session)

      session.pendingFinalTimer = setTimeout(() => {
        void this.finalizePendingTranscript(session)
      }, 700)

      return
    }

    if (event.type === 'stt_error') {
      const isBufferTooSmall =
        typeof event.message === 'string' &&
        event.message.includes('buffer too small')

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
          `[STT ERROR IGNORED] ${session.id} reason=${reason} ${event.message}`,
        )

        appendVoiceTrace({
          type: 'stt_error_ignored',
          sessionId: session.id,
          conversationId: session.conversationId,
          message: event.message,
          reason,
          pendingFinalTranscript: session.pendingFinalTranscript,
          clientTurnEnded: session.clientTurnEnded,
        })

        return
      }

      this.logger.error(`[STT ERROR] ${session.id} ${event.message}`)

      appendVoiceTrace({
        type: 'stt_error',
        sessionId: session.id,
        conversationId: session.conversationId,
        message: event.message,
      })

      this.emitToBoth(session, {
        type: 'error',
        sessionId: session.id,
        message: event.message,
      })
    }
  }

  private extractSpeakableChunk(buffer: string): {
    chunk: string | null
    remainder: string
  } {
    const trimmed = buffer.trimStart()
    if (!trimmed) {
      return { chunk: null, remainder: '' }
    }

    const sentenceMatch = trimmed.match(/^(.+?[.!?…]+)(\s+|$)/)
    if (sentenceMatch) {
      const chunk = sentenceMatch[1].trim()
      const remainder = trimmed.slice(sentenceMatch[0].length).trimStart()
      return { chunk, remainder }
    }

    if (trimmed.length >= 140) {
      let splitAt = trimmed.lastIndexOf(',', 140)
      if (splitAt < 60) splitAt = trimmed.lastIndexOf(' ', 140)
      if (splitAt < 40) splitAt = 140

      const chunk = trimmed.slice(0, splitAt).trim()
      const remainder = trimmed.slice(splitAt).trimStart()
      return { chunk, remainder }
    }

    return { chunk: null, remainder: trimmed }
  }

  private async sendAssistantAudioChunkFromText(
    session: ActiveVoiceSession,
    textChunk: string,
    chunkIndex: number,
    isLastChunk: boolean,
  ): Promise<void> {
    const synthesized = await this.synthesisService.synthesize(textChunk)

    this.sendToClient(session, {
      type: 'assistant_audio_chunk',
      sessionId: session.id,
      format: synthesized.format,
      chunkIndex,
      isLastChunk,
      text: textChunk,
      audioBase64: synthesized.audioBuffer.toString('base64'),
    })

    this.debugEvents.emit({
      type: 'assistant_audio_chunk',
      sessionId: session.id,
      format: synthesized.format,
      bytes: synthesized.audioBuffer.length,
      chunkIndex,
      isLastChunk,
      text: textChunk,
    })

    appendVoiceTrace({
      type: 'assistant_audio_chunk',
      sessionId: session.id,
      conversationId: session.conversationId,
      bytes: synthesized.audioBuffer.length,
      chunkIndex,
      isLastChunk,
      text: textChunk,
      assistantAudioAt: Date.now(),
    })
  }

}
