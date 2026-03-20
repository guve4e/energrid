import { WebSocketGateway, OnGatewayConnection } from '@nestjs/websockets'
import { WebSocket } from 'ws'
import { VoiceSessionService } from './voice-session.service'

@WebSocketGateway({ path: '/voice' })
export class VoiceGateway implements OnGatewayConnection {
  constructor(private readonly voiceSessionService: VoiceSessionService) {}

  async handleConnection(client: WebSocket) {
    console.log('[VOICE WS CONNECTED]')

    await this.voiceSessionService.openSession(client)

    client.on('message', async (data: Buffer, isBinary: boolean) => {
      if (!isBinary) {
        try {
          const text = data.toString()
          const message = JSON.parse(text)

          if (message.type === 'end_of_turn') {
            await this.voiceSessionService.endTurn(client)
          }
        } catch {
          console.log('unexpected text message on /voice:', data.toString())
        }
        return
      }

      await this.voiceSessionService.pushAudio(client, Buffer.from(data))
    })

    client.on('close', async () => {
      console.log('[VOICE WS CLOSED]')
      await this.voiceSessionService.closeSession(client)
    })
  }
}
