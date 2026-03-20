import { Injectable, Logger } from '@nestjs/common'
import { WebSocket } from 'ws'
import { randomUUID } from 'crypto'

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
  partialTranscript: string
  finalTranscript: string
  assistantReply: string
  startedAt: number
  lastChunkAt: number
  turnEnded: boolean
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

    let session!: ActiveVoiceSession

    const sttSession = await this.sttService.createSession(
      async (event: StreamingSttEvent) => {
        await this.handleSttEvent(session, event)
      },
    )

    session = {
      id,
      conversationId,
      client,
      sttSession,
      chunkCount: 0,
      partialTranscript: '',
      finalTranscript: '',
      assistantReply: '',
      startedAt: Date.now(),
      lastChunkAt: Date.now(),
      turnEnded: false,
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

    if (session.turnEnded) {
      this.logger.log(
        `[TURN END IGNORED] ${session.id} conversation=${session.conversationId} already finalized`,
      )
      return
    }

    session.turnEnded = true

    this.logger.log(
      `[TURN END] ${session.id} conversation=${session.conversationId}`,
    )

    try {
      await session.sttSession.endInput()
    } catch (e) {
      this.logger.warn(`STT endInput error: ${String(e)}`)
    }
  }

  async closeSession(client: WebSocket): Promise<void> {
    const session = this.sessions.get(client)
    if (!session) return

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

    this.sessions.delete(client)
  }

  private async handleSttEvent(
    session: ActiveVoiceSession,
    event: StreamingSttEvent,
  ): Promise<void> {
    if (event.type === 'stt_partial') {
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
      session.finalTranscript = event.text

      this.logger.log(`[STT FINAL] ${session.id} ${session.finalTranscript}`)

      this.emitToBoth(session, {
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

      this.logger.log(`[ASSISTANT] ${session.id} ${result.replyText}`)

      this.emitToBoth(session, {
        type: 'assistant_final',
        sessionId: session.id,
        text: result.replyText,
      })

      const synthesized = await this.synthesisService.synthesize(
        result.replyText,
      )

      this.sendToClient(session, {
        type: 'assistant_audio',
        sessionId: session.id,
        format: synthesized.format,
        audioBase64: synthesized.audioBuffer.toString('base64'),
      })

      this.debugEvents.emit({
        type: 'assistant_audio',
        sessionId: session.id,
        format: synthesized.format,
        bytes: synthesized.audioBuffer.length,
      })

      this.emitToBoth(session, {
        type: 'turn_end',
        sessionId: session.id,
      })

      return
    }

    if (event.type === 'stt_error') {
      this.logger.error(`[STT ERROR] ${session.id} ${event.message}`)

      this.emitToBoth(session, {
        type: 'error',
        sessionId: session.id,
        message: event.message,
      })
    }
  }
}
