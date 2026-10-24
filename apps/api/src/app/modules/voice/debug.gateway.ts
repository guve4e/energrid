import { WebSocketGateway, OnGatewayConnection } from '@nestjs/websockets'
import { WebSocket } from 'ws'
import { DebugEventsService } from './debug-events.service'
import { authenticateVoiceToken } from './voice-auth'
import { AuthService } from '../auth/auth.service'

@WebSocketGateway({ path: '/voice-debug', maxPayload: 4096 })
export class DebugGateway implements OnGatewayConnection {
  constructor(private readonly debugEvents: DebugEventsService, private readonly auth: AuthService) {}

  handleConnection(client: WebSocket) {
    if (process.env.VOICE_DEBUG_ENABLED !== 'true') {
      client.close(1008, 'Voice debug is disabled')
      return
    }

    let authenticated = false
    let accessToken = ''
    const authTimeout = setTimeout(() => {
      if (!authenticated) client.close(1008, 'Authentication required')
    }, 5000)

    client.on('message', async (data, isBinary) => {
      if (authenticated || isBinary) {
        client.close(1008, 'Invalid debug protocol')
        return
      }

      try {
        const message = JSON.parse(data.toString())
        const principal = message?.type === 'authenticate' ? await authenticateVoiceToken(this.auth, message.token) : null
        if (!principal) {
          client.close(1008, 'Invalid debug credentials')
          return
        }

        accessToken = message.token
        authenticated = true
        clearTimeout(authTimeout)
        this.debugEvents.addClient(client)
        client.send(JSON.stringify({ type: 'debug_authenticated' }))
      } catch {
        client.close(1008, 'Invalid authentication message')
      }
    })

    const validateSession = setInterval(async () => {
      if (authenticated && !await authenticateVoiceToken(this.auth, accessToken)) client.close(1008, 'Authentication expired')
    }, 30_000)

    client.on('close', () => {
      clearTimeout(authTimeout)
      clearInterval(validateSession)
      this.debugEvents.removeClient(client)
    })
  }
}
