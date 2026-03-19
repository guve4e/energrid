import type {
  IStreamingSttProvider,
  StreamingSttEvent,
  StreamingSttSession,
} from '../../stt-stream-core/src/index'

class DevStreamingSttSession implements StreamingSttSession {
  private listeners: Array<(event: StreamingSttEvent) => void> = []
  private totalBytes = 0

  async pushAudio(chunk: Buffer): Promise<void> {
    this.totalBytes += chunk.length
  }

  async endInput(): Promise<void> {
    this.emit({
      type: 'stt_error',
      message: `No real STT provider yet. Received ${this.totalBytes} bytes.`,
    })
  }

  async close(): Promise<void> {}

  onEvent(cb: (event: StreamingSttEvent) => void): void {
    this.listeners.push(cb)
  }

  private emit(event: StreamingSttEvent) {
    for (const listener of this.listeners) listener(event)
  }
}

export function createDevStreamingSttProvider(): IStreamingSttProvider {
  return {
    async createSession(): Promise<StreamingSttSession> {
      return new DevStreamingSttSession()
    },
  }
}
