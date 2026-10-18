import { WebSocketGateway, OnGatewayConnection } from '@nestjs/websockets'
import { WebSocket } from 'ws'
import { DebugEventsService } from './debug-events.service'
import { isValidVoiceToken } from './voice-auth'

@WebSocketGateway({ path: '/voice-debug', maxPayload: 4096 })
export class DebugGateway implements OnGatewayConnection {
  constructor(private readonly debugEvents: DebugEventsService) {}

  handleConnection(client: WebSocket) {
    if (process.env.VOICE_DEBUG_ENABLED !== 'true') {
      client.close(1008, 'Voice debug is disabled')
      return
    }

    let authenticated = false
    const authTimeout = setTimeout(() => {
      if (!authenticated) client.close(1008, 'Authentication required')
    }, 5000)

    client.on('message', (data, isBinary) => {
      if (authenticated || isBinary) {
        client.close(1008, 'Invalid debug protocol')
        return
      }

      try {
        const message = JSON.parse(data.toString())
        if (message?.type !== 'authenticate' || !isValidVoiceToken(message.token)) {
          client.close(1008, 'Invalid debug credentials')
          return
        }

        authenticated = true
        clearTimeout(authTimeout)
        this.debugEvents.addClient(client)
        client.send(JSON.stringify({ type: 'debug_authenticated' }))
      } catch {
        client.close(1008, 'Invalid authentication message')
      }
    })

    client.on('close', () => {
      clearTimeout(authTimeout)
      this.debugEvents.removeClient(client)
    })
  }
}
