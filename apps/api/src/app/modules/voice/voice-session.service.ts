import { Injectable, Logger } from '@nestjs/common'
import { WebSocket } from 'ws'
import { randomUUID } from 'crypto'

import { VoiceSttService } from './voice-stt.service'
import { DebugEventsService } from './debug-events.service'
import { VoiceConversationService } from './voice-conversation.service'
import type {
  StreamingSttEvent,
  StreamingSttSession,
} from '@energrid/stt-stream-core'
import {VoiceSynthesisService} from "./voice-synthesis.service";

interface ActiveVoiceSession {
  id: string
  client: WebSocket
  conversationId: string
  sttSession: StreamingSttSession
  chunkCount: number
  partialTranscript: string
  finalTranscript: string
  assistantReply: string
  startedAt: number
  lastChunkAt: number
  inputEnded: boolean
  replySent: boolean
}

@Injectable()
export class VoiceSessionService {
  private readonly logger = new Logger(VoiceSessionService.name)
  private readonly sessions = new Map<WebSocket, ActiveVoiceSession>()
  private readonly verbose = process.env.VOICE_VERBOSE_LOGS === 'true'

  constructor(
    private readonly sttService: VoiceSttService,
    private readonly debugEvents: DebugEventsService,
    private readonly conversationService: VoiceConversationService,
    private readonly synthesisService: VoiceSynthesisService,
  ) {}

  async openSession(client: WebSocket): Promise<void> {
    const id = randomUUID()
    const conversationId = randomUUID()

    this.logger.log(`[SESSION START] ${id} conversation=${conversationId}`)

    let session!: ActiveVoiceSession

    const sttSession = await this.sttService.createSession(
      (event: StreamingSttEvent) => {
        void this.handleSttEvent(session, event)
      },
    )

    session = {
      id,
      client,
      conversationId,
      sttSession,
      chunkCount: 0,
      partialTranscript: '',
      finalTranscript: '',
      assistantReply: '',
      startedAt: Date.now(),
      lastChunkAt: Date.now(),
      inputEnded: false,
      replySent: false,
    }

    this.sessions.set(client, session)

    this.emitToVoiceClient(session.client, {
      type: 'session_start',
      sessionId: id,
      conversationId,
    })

    this.debugEvents.emit({
      type: 'session_start',
      sessionId: id,
      conversationId,
    })
  }

  setConversationId(client: WebSocket, conversationId: string): void {
    const session = this.sessions.get(client)
    if (!session) return

    session.conversationId = conversationId

    if (this.verbose) {
      this.logger.log(
        `[CONVERSATION ID SET] session=${session.id} conversation=${conversationId}`,
      )
    }
  }

  async pushAudio(client: WebSocket, buf: Buffer): Promise<void> {
    const session = this.sessions.get(client)
    if (!session) return
    if (session.inputEnded) return

    session.chunkCount++
    session.lastChunkAt = Date.now()

    if (this.verbose && (session.chunkCount === 1 || session.chunkCount % 10 === 0)) {
      this.logger.log(
        `[CHUNK] ${session.id} count=${session.chunkCount} bytes=${buf.length}`,
      )
    }

    // Debug clients may want chunk telemetry, but the device client does not.
    this.debugEvents.emit({
      type: 'chunk',
      sessionId: session.id,
      conversationId: session.conversationId,
      chunkCount: session.chunkCount,
      bytes: buf.length,
    })

    await session.sttSession.pushAudio(buf)
  }

  async endTurn(client: WebSocket): Promise<void> {
    const session = this.sessions.get(client)
    if (!session) return

    if (session.inputEnded) return

    // If we already got final transcript or already sent a reply,
    // do not try to commit input again.
    if (session.finalTranscript.trim() || session.replySent) {
      session.inputEnded = true

      this.logger.log(
        `[TURN END IGNORED] ${session.id} conversation=${session.conversationId} already finalized`,
      )

      this.emitToVoiceClient(session.client, {
        type: 'turn_end_ignored',
        sessionId: session.id,
        conversationId: session.conversationId,
      })

      this.debugEvents.emit({
        type: 'turn_end_ignored',
        sessionId: session.id,
        conversationId: session.conversationId,
      })

      return
    }

    session.inputEnded = true

    this.logger.log(
      `[TURN END] ${session.id} conversation=${session.conversationId} chunks=${session.chunkCount}`,
    )

    this.emitToVoiceClient(session.client, {
      type: 'turn_end',
      sessionId: session.id,
      conversationId: session.conversationId,
    })

    this.debugEvents.emit({
      type: 'turn_end',
      sessionId: session.id,
      conversationId: session.conversationId,
    })

    try {
      await session.sttSession.endInput()
    } catch (e) {
      this.logger.warn(`[STT END INPUT ERROR] ${session.id} ${String(e)}`)
    }
  }

  async closeSession(client: WebSocket): Promise<void> {
    const session = this.sessions.get(client)
    if (!session) return

    if (this.verbose) {
      this.logger.log(`[SESSION CLOSING] ${session.id}`)
    }

    if (!session.inputEnded && !session.finalTranscript.trim() && !session.replySent) {
      try {
        await session.sttSession.endInput()
      } catch (e) {
        this.logger.warn(`[STT END INPUT ERROR] ${session.id} ${String(e)}`)
      }
      session.inputEnded = true
    }

    try {
      await session.sttSession.close()
    } catch (e) {
      this.logger.warn(`[STT CLOSE ERROR] ${session.id} ${String(e)}`)
    }

    this.logger.log(
      `[SESSION END] ${session.id} conversation=${session.conversationId} transcript="${session.finalTranscript.trim()}"`,
    )

    this.emitToVoiceClient(session.client, {
      type: 'session_end',
      sessionId: session.id,
      conversationId: session.conversationId,
      totalChunks: session.chunkCount,
      finalTranscript: session.finalTranscript.trim(),
      assistantReply: session.assistantReply,
      durationMs: Date.now() - session.startedAt,
    })

    this.debugEvents.emit({
      type: 'session_end',
      sessionId: session.id,
      conversationId: session.conversationId,
      totalChunks: session.chunkCount,
      finalTranscript: session.finalTranscript.trim(),
      assistantReply: session.assistantReply,
      durationMs: Date.now() - session.startedAt,
    })

    this.sessions.delete(client)
  }

  private async handleSttEvent(
    session: ActiveVoiceSession,
    event: StreamingSttEvent,
  ): Promise<void> {
    if (event.type === 'stt_partial') {
      session.partialTranscript += event.text

      this.emitToVoiceClient(session.client, {
        type: 'stt_partial',
        sessionId: session.id,
        conversationId: session.conversationId,
        text: event.text,
        full: session.partialTranscript,
      })

      this.debugEvents.emit({
        type: 'stt_partial',
        sessionId: session.id,
        conversationId: session.conversationId,
        text: event.text,
        full: session.partialTranscript,
      })

      return
    }

    if (event.type === 'stt_final') {
      session.finalTranscript = event.text

      this.debugEvents.emit({
        type: 'stt_final',
        sessionId: session.id,
        text: event.text,
        full: session.finalTranscript,
      })


      const result = await this.conversationService.handleFinalTranscript({
        conversationId: session.conversationId,
        sessionId: session.id,
        transcript: session.finalTranscript,
      })

      session.assistantReply = result.replyText

      this.debugEvents.emit({
        type: 'assistant_final',
        sessionId: session.id,
        text: result.replyText,
      })

      const synthesized = await this.synthesisService.synthesize(result.replyText)

      this.debugEvents.emit({
        type: 'assistant_audio',
        sessionId: session.id,
        format: synthesized.format,
        audioBase64: synthesized.audioBuffer.toString('base64'),
      })

      this.debugEvents.emit({
        type: 'turn_end',
        sessionId: session.id,
      })

      return
    }

    if (event.type === 'stt_error') {
      this.logger.error(`[STT ERROR] ${session.id} ${event.message}`)

      this.emitToVoiceClient(session.client, {
        type: 'stt_error',
        sessionId: session.id,
        conversationId: session.conversationId,
        message: event.message,
      })

      this.debugEvents.emit({
        type: 'stt_error',
        sessionId: session.id,
        conversationId: session.conversationId,
        message: event.message,
      })
    }
  }

  private emitToVoiceClient(client: WebSocket, payload: Record<string, unknown>) {
    if (client.readyState !== WebSocket.OPEN) return

    try {
      client.send(JSON.stringify(payload))
    } catch (e) {
      this.logger.warn(`[VOICE CLIENT SEND ERROR] ${String(e)}`)
    }
  }
}
