import { WebSocketGateway, OnGatewayConnection } from '@nestjs/websockets'
import { WebSocket } from 'ws'
import { VoiceSessionService } from './voice-session.service'
import { isValidVoiceToken } from './voice-auth'

@WebSocketGateway({ path: '/voice', maxPayload: 64 * 1024 })
export class VoiceGateway implements OnGatewayConnection {
  private readonly clients = new Set<WebSocket>()
  private readonly maxConnections = 16

  constructor(private readonly voiceSessionService: VoiceSessionService) {}

  async handleConnection(client: WebSocket) {
    if (this.clients.size >= this.maxConnections) {
      client.close(1013, 'Voice service is at capacity')
      return
    }

    this.clients.add(client)
    let authenticated = false
    const authTimeout = setTimeout(() => {
      if (!authenticated) client.close(1008, 'Authentication required')
    }, 5000)

    client.on('message', async (data: Buffer, isBinary: boolean) => {
      if (!authenticated) {
        if (isBinary) {
          client.close(1008, 'Authenticate before sending audio')
          return
        }

        try {
          const message = JSON.parse(data.toString())
          if (message?.type !== 'authenticate' || !isValidVoiceToken(message.token)) {
            client.close(1008, 'Invalid voice credentials')
            return
          }

          authenticated = true
          clearTimeout(authTimeout)
          await this.voiceSessionService.openSession(client)
          client.send(JSON.stringify({ type: 'authenticated' }))
        } catch {
          client.close(1008, 'Invalid authentication message')
        }
        return
      }

      if (!isBinary) {
        try {
          const text = data.toString()
          const message = JSON.parse(text)

          if (message.type === 'end_of_turn') {
            await this.voiceSessionService.endTurn(client)
          } else if (message.type === 'confirm_action') {
            await this.voiceSessionService.confirmPendingAction(client, message.approvalId)
          } else if (message.type === 'cancel_action') {
            this.voiceSessionService.cancelPendingAction(client, message.approvalId)
          } else {
            client.close(1008, 'Unsupported voice message')
          }
        } catch {
          client.close(1008, 'Invalid voice message')
        }
        return
      }

      try {
        await this.voiceSessionService.pushAudio(client, Buffer.from(data))
      } catch {
        client.close(1011, 'Voice turn failed')
      }
    })

    client.on('close', async () => {
      clearTimeout(authTimeout)
      this.clients.delete(client)
      if (authenticated) await this.voiceSessionService.closeSession(client)
    })
  }
}
