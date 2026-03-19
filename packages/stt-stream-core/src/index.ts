export type SttPartialEvent = {
  type: 'stt_partial'
  text: string
}

export type SttFinalEvent = {
  type: 'stt_final'
  text: string
}

export type SttErrorEvent = {
  type: 'stt_error'
  message: string
}

export type StreamingSttEvent =
  | SttPartialEvent
  | SttFinalEvent
  | SttErrorEvent

export interface StreamingSttSession {
  pushAudio(chunk: Buffer): Promise<void>
  endInput(): Promise<void>
  close(): Promise<void>
  onEvent(cb: (event: StreamingSttEvent) => void): void
}

export interface IStreamingSttProvider {
  createSession(input: {
    mimeType: string
    sampleRate?: number
    language?: string
  }): Promise<StreamingSttSession>
}
