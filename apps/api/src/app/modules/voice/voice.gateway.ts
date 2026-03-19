import { WebSocketGateway, OnGatewayConnection } from '@nestjs/websockets'
import { WebSocket } from 'ws'
import { DebugEventsService } from './debug-events.service'
import { VoiceSttService } from './voice-stt.service'

@WebSocketGateway({ path: '/voice' })
export class VoiceGateway implements OnGatewayConnection {
  constructor(
    private readonly debugEvents: DebugEventsService,
    private readonly voiceStt: VoiceSttService,
  ) {}

  async handleConnection(client: WebSocket) {
    let chunkCount = 0

    const sttSession = await this.voiceStt.createSession((event) => {
      console.log('broadcasting event to debug clients', event)
      this.debugEvents.emit(event)
    })

    console.log('voice client connected')

    client.on('message', async (data: Buffer, isBinary: boolean) => {
      if (!isBinary) {
        console.log('unexpected text message on /voice:', data.toString())
        return
      }

      chunkCount++
      const buf = Buffer.from(data)

      console.log('audio chunk received', chunkCount, buf.length)

      this.debugEvents.emit({
        type: 'chunk',
        chunkCount,
        bytes: buf.length,
      })

      await sttSession.pushAudio(buf)
    })

    client.on('close', async () => {
      console.log('voice client disconnected')
      console.log('ending stt input')

      await sttSession.endInput()
      await sttSession.close()

      this.debugEvents.emit({
        type: 'session-end',
        totalChunks: chunkCount,
      })
    })
  }
}
