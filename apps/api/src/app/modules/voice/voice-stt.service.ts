import { Injectable } from '@nestjs/common'
import { createOpenAIStreamingSttProvider } from '@energrid/stt-stream-openai'
import type {
  StreamingSttEvent,
  StreamingSttSession,
} from '@energrid/stt-stream-core'

@Injectable()
export class VoiceSttService {
  private provider = createOpenAIStreamingSttProvider()

  async createSession(
    onEvent: (event: StreamingSttEvent) => void,
  ): Promise<StreamingSttSession> {
    console.log('VoiceSttService.createSession called')

    const session = await this.provider.createSession({
      mimeType: 'audio/pcm',
      sampleRate: 16000,
      language: 'bg',
    })

    console.log('VoiceSttService session created')

    session.onEvent((event) => {
      console.log('STT EVENT', event)
      onEvent(event)
    })

    return session
  }
}
