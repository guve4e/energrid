import { WebSocketGateway, OnGatewayConnection } from '@nestjs/websockets'
import { WebSocket } from 'ws'
import { DebugEventsService } from './debug-events.service'

@WebSocketGateway({ path: '/voice-debug' })
export class DebugGateway implements OnGatewayConnection {
  constructor(private readonly debugEvents: DebugEventsService) {}

  handleConnection(client: WebSocket) {
    console.log('debug client connected')
    this.debugEvents.addClient(client)

    client.send(
      JSON.stringify({
        type: 'debug',
        message: 'debug client attached ok',
      }),
    )

    client.on('close', () => {
      console.log('debug client disconnected')
      this.debugEvents.removeClient(client)
    })
  }
}
