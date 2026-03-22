window.createVoiceState = function createVoiceState() {
  return {
    conversationId: crypto.randomUUID(),
    currentSessionId: '',
    state: 'idle',

    listeningArmed: false,
    finalReceivedForCurrentTurn: false,
    suppressAutoListenUntil: 0,
    assistantAudioPlaying: false,

    turnCounter: 0,
    currentTurn: null,
  }
}
