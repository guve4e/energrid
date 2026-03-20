export type VoiceServerEvent =
  | {
  type: 'session_start'
  sessionId: string
  conversationId: string
}
  | {
  type: 'stt_partial'
  sessionId: string
  text: string
  full: string
}
  | {
  type: 'stt_final'
  sessionId: string
  text: string
  full: string
}
  | {
  type: 'assistant_final'
  sessionId: string
  text: string
}
  | {
  type: 'assistant_audio'
  sessionId: string
  format: 'wav'
  audioBase64: string
}
  | {
  type: 'turn_end'
  sessionId: string
}
  | {
  type: 'error'
  sessionId?: string
  message: string
}
