import { Injectable } from '@nestjs/common'
import { WebSocket } from 'ws'

@Injectable()
export class DebugEventsService {
  private clients = new Set<WebSocket>()

  addClient(client: WebSocket) {
    this.clients.add(client)
  }

  removeClient(client: WebSocket) {
    this.clients.delete(client)
  }

  emit(event: Record<string, unknown>) {
    const message = JSON.stringify(event)

    for (const client of this.clients) {
      if (client.readyState === 1) {
        client.send(message)
      }
    }
  }
}
