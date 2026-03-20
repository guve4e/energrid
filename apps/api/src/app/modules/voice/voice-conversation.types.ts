export interface VoiceConversationInput {
  sessionId: string
  conversationId: string
  transcript: string
}

export interface VoiceConversationResult {
  replyText: string
}
