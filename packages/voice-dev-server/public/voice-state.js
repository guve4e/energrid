window.createVoiceState = function createVoiceState() {
  return {
    conversationId: crypto.randomUUID(),
    currentSessionId: '',

    state: 'idle',

    listeningArmed: false,
    finalReceivedForCurrentTurn: false,
    suppressAutoListenUntil: 0,
    assistantAudioPlaying: false,

    currentUserMessage: null,
    currentAssistantMessage: null,

    turnCounter: 0,
    currentTurn: null,
  }
}
