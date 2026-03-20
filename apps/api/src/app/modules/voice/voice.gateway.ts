import { WebSocketGateway, OnGatewayConnection } from '@nestjs/websockets'
import { WebSocket } from 'ws'
import { VoiceSessionService } from './voice-session.service'

@WebSocketGateway({ path: '/voice' })
export class VoiceGateway implements OnGatewayConnection {
  constructor(private readonly sessions: VoiceSessionService) {}

  async handleConnection(client: WebSocket) {
    console.log('[VOICE WS CONNECTED]')

    await this.sessions.openSession(client)

    client.on('message', async (data: Buffer, isBinary: boolean) => {
      if (!isBinary) {
        try {
          const text = data.toString()
          const payload = JSON.parse(text)

          if (
            payload?.type === 'conversation_init' &&
            typeof payload.conversationId === 'string'
          ) {
            this.sessions.setConversationId(client, payload.conversationId)
            return
          }

          if (payload?.type === 'end_of_turn') {
            await this.sessions.endTurn(client)
            return
          }

          console.log('[VOICE WS TEXT MESSAGE IGNORED]', text)
        } catch {
          console.log('[VOICE WS TEXT MESSAGE IGNORED]')
        }

        return
      }

      await this.sessions.pushAudio(client, Buffer.from(data))
    })

    client.on('close', async () => {
      console.log('[VOICE WS CLOSED]')
      await this.sessions.closeSession(client)
    })
  }
}
