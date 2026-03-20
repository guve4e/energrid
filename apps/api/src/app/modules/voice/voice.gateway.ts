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
        console.log('[VOICE WS TEXT MESSAGE IGNORED]', data.toString())
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
