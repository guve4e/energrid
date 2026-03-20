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

interface ActiveVoiceSession {
  id: string
  client: WebSocket
  sttSession: StreamingSttSession
  chunkCount: number
  partialTranscript: string
  finalTranscript: string
  assistantReply: string
  startedAt: number
  lastChunkAt: number
}

@Injectable()
export class VoiceSessionService {
  private readonly logger = new Logger(VoiceSessionService.name)
  private readonly sessions = new Map<WebSocket, ActiveVoiceSession>()

  constructor(
    private readonly sttService: VoiceSttService,
    private readonly debugEvents: DebugEventsService,
    private readonly conversationService: VoiceConversationService,
  ) {}

  async openSession(client: WebSocket): Promise<void> {
    const id = randomUUID()
    this.logger.log(`[SESSION START] ${id}`)

    let session!: ActiveVoiceSession

    const sttSession = await this.sttService.createSession(
      (event: StreamingSttEvent) => {
        void this.handleSttEvent(session, event)
      },
    )

    session = {
      id,
      client,
      sttSession,
      chunkCount: 0,
      partialTranscript: '',
      finalTranscript: '',
      assistantReply: '',
      startedAt: Date.now(),
      lastChunkAt: Date.now(),
    }

    this.sessions.set(client, session)

    this.debugEvents.emit({
      type: 'session_start',
      sessionId: id,
    })
  }

  async pushAudio(client: WebSocket, buf: Buffer): Promise<void> {
    const session = this.sessions.get(client)
    if (!session) return

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

  async closeSession(client: WebSocket): Promise<void> {
    const session = this.sessions.get(client)
    if (!session) return

    this.logger.log(`[SESSION ENDING] ${session.id}`)

    try {
      await session.sttSession.endInput()
    } catch (e) {
      this.logger.warn(`[STT END INPUT ERROR] ${session.id} ${String(e)}`)
    }

    try {
      await session.sttSession.close()
    } catch (e) {
      this.logger.warn(`[STT CLOSE ERROR] ${session.id} ${String(e)}`)
    }

    this.logger.log(
      `[SESSION END] ${session.id} chunks=${session.chunkCount} transcript="${session.finalTranscript.trim()}" reply="${session.assistantReply}"`,
    )

    this.debugEvents.emit({
      type: 'session_end',
      sessionId: session.id,
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

      this.debugEvents.emit({
        type: 'stt_partial',
        sessionId: session.id,
        text: event.text,
        full: session.partialTranscript,
      })

      return
    }

    if (event.type === 'stt_final') {
      session.finalTranscript = event.text

      this.logger.log(`[STT FINAL] ${session.id} ${event.text}`)

      this.debugEvents.emit({
        type: 'stt_final',
        sessionId: session.id,
        text: event.text,
        full: session.finalTranscript,
      })

      const result = await this.conversationService.handleFinalTranscript({
        sessionId: session.id,
        transcript: session.finalTranscript,
      })

      session.assistantReply = result.replyText

      this.logger.log(`[ASSISTANT] ${session.id} ${result.replyText}`)

      this.debugEvents.emit({
        type: 'assistant_final',
        sessionId: session.id,
        text: result.replyText,
      })

      return
    }

    if (event.type === 'stt_error') {
      this.logger.error(`[STT ERROR] ${session.id} ${event.message}`)

      this.debugEvents.emit({
        type: 'stt_error',
        sessionId: session.id,
        message: event.message,
      })
    }
  }
}
