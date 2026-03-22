window.createVoiceController = function createVoiceController({
                                                                config,
                                                                state,
                                                                ui,
                                                              }) {
  const wsClient = window.createVoiceWsClient({
    wsUrl: config.WS_URL,
    log: ui.log,
  })

  const player = window.createVoiceAudioPlayerBrowser({
    log: ui.log,
    onPlaybackStart: handlePlaybackStart,
    onPlaybackEnd: handlePlaybackEnd,
  })

  const vadClient = window.createVoiceVadBrowser({
    config,
    log: ui.log,
    onSpeechStart: handleSpeechStart,
    onSpeechEnd: (audio) => {
      void processSpeechSegment(audio)
    },
    onMisfire: handleVadMisfire,
  })

  function init() {
    ui.setConversationId(state.conversationId)
    setState('idle')

    ui.bindButtons({
      onStart: startSession,
      onStop: stopSession,
      onNewConversation: startNewConversation,
      onClearLog: clearLog,
    })
  }

  function nowMs() {
    return Date.now()
  }

  function formatMs(ms) {
    if (ms == null) return ''
    return `${Math.round(ms)}ms`
  }

  function clearLog() {
    ui.els.log.textContent = ''
  }

  function setState(next) {
    state.state = next
    ui.setStatus(next)
    renderVadInfo()
  }

  function renderVadInfo(extra = {}) {
    ui.renderVadInfo({
      listeningArmed: state.listeningArmed,
      assistantAudioPlaying: state.assistantAudioPlaying,
      suppressRemainingMs: getSuppressRemainingMs(),
      state: state.state,
      ...extra,
    })
  }

  function getSuppressRemainingMs() {
    return Math.max(0, state.suppressAutoListenUntil - nowMs())
  }

  function isAutoListenSuppressed() {
    return state.assistantAudioPlaying || nowMs() < state.suppressAutoListenUntil
  }

  function handlePlaybackStart() {
    state.assistantAudioPlaying = true
    state.suppressAutoListenUntil = Math.max(
      state.suppressAutoListenUntil,
      nowMs() + config.ASSISTANT_PLAYBACK_GRACE_MS,
    )
    renderVadInfo()
  }

  function handlePlaybackEnd() {
    state.assistantAudioPlaying = false
    state.suppressAutoListenUntil = Math.max(
      state.suppressAutoListenUntil,
      nowMs() + config.ASSISTANT_PLAYBACK_GRACE_MS,
    )
    renderVadInfo()
  }

  function handleSpeechStart() {
    // keep for future visual feedback / metrics
  }

  function handleVadMisfire() {
    // keep for future debug hooks
  }

  function createNewTurn() {
    state.turnCounter += 1

    state.currentTurn = {
      index: state.turnCounter,
      conversationId: state.conversationId,
      sessionId: '',

      speechCapturedAt: null,
      wsCreateAt: null,
      wsOpenAt: null,
      audioSendStartAt: null,
      audioSendEndAt: null,

      sttFinalAt: null,
      assistantFirstDeltaAt: null,
      assistantFirstAudioAt: null,
      assistantFinalAt: null,
      turnEndAt: null,

      transcript: '',
      reply: '',
      speechBytes: 0,
      speechSeconds: 0,
    }
  }

  function resetTurnVisualState() {
    state.finalReceivedForCurrentTurn = false
    state.currentUserMessage = null
    state.currentAssistantMessage = null
    ui.setPartial('')
  }

  function ensureAssistantMessage() {
    if (!state.currentAssistantMessage) {
      state.currentAssistantMessage = ui.createMessage('assistant', '')
    }
    return state.currentAssistantMessage
  }

  function appendAssistantDelta(delta, fullText) {
    const message = ensureAssistantMessage()
    message.textEl.textContent =
      fullText || ((message.textEl.textContent || '') + delta)
  }

  function floatTo16BitPCM(float32Array) {
    const int16Array = new Int16Array(float32Array.length)

    for (let i = 0; i < float32Array.length; i++) {
      let s = Math.max(-1, Math.min(1, float32Array[i]))
      int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7fff
    }

    return int16Array
  }

  function sendPcmAsChunks(audioFloat32) {
    const pcm16 = floatTo16BitPCM(audioFloat32)
    const bytes = pcm16.byteLength

    for (
      let start = 0;
      start < pcm16.length;
      start += config.PCM_CHUNK_SAMPLES
    ) {
      const slice = pcm16.subarray(
        start,
        Math.min(start + config.PCM_CHUNK_SAMPLES, pcm16.length),
      )

      wsClient.sendBinary(
        slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength),
      )
    }

    return bytes
  }

  async function processSpeechSegment(audioFloat32) {
    if (!canProcessSpeechSegment()) {
      return
    }

    resetTurnVisualState()
    createNewTurn()
    setState('connecting_turn')
    ui.log('[voice] speech segment received from MicVAD -> opening turn socket')

    captureSpeechStart(audioFloat32)
    renderSpeechInfo(audioFloat32)

    try {
      openTurnSocket(audioFloat32)
    } catch (error) {
      handleSocketConstructionError(error)
    }
  }

  function canProcessSpeechSegment() {
    if (!state.listeningArmed) {
      ui.log('[voice] dropped speech segment because session is not armed')
      return false
    }

    if (isAutoListenSuppressed()) {
      ui.log('[voice] dropped speech segment because auto-listen is suppressed')
      return false
    }

    if (wsClient.hasSocket()) {
      ui.log('[voice] dropped speech segment because previous turn is still active')
      return false
    }

    return true
  }

  function captureSpeechStart(audioFloat32) {
    if (!state.currentTurn) return

    state.currentTurn.speechCapturedAt = nowMs()
    state.currentTurn.speechSeconds = audioFloat32.length / config.PCM_SAMPLE_RATE
  }

  function renderSpeechInfo(audioFloat32) {
    const speechSeconds = audioFloat32.length / config.PCM_SAMPLE_RATE

    renderVadInfo({
      lastSpeechBytes: audioFloat32.length * 4,
      lastSpeechSeconds: speechSeconds,
    })
  }

  function openTurnSocket(audioFloat32) {
    if (state.currentTurn) {
      state.currentTurn.wsCreateAt = nowMs()
    }

    wsClient.connect({
      onOpen: () => handleSocketOpen(audioFloat32),
      onMessage: handleSocketMessage,
      onClose: handleSocketClose,
      onError: handleSocketError,
    })
  }

  function handleSocketConstructionError(error) {
    ui.log(`[voice] websocket constructor failed: ${String(error)}`)
    console.error(error)
    cleanupTurnSocket()
    setState(state.listeningArmed ? 'armed_listening' : 'error')
  }

  function handleSocketOpen(audioFloat32) {
    ui.log('[voice] connected')
    setState('streaming_turn')

    sendCapturedSpeech(audioFloat32)
    sendEndOfTurn()
  }

  function sendCapturedSpeech(audioFloat32) {
    if (state.currentTurn) {
      state.currentTurn.wsOpenAt = nowMs()
      state.currentTurn.audioSendStartAt = nowMs()
    }

    const sentBytes = sendPcmAsChunks(audioFloat32)
    const speechSeconds = audioFloat32.length / config.PCM_SAMPLE_RATE

    if (state.currentTurn) {
      state.currentTurn.audioSendEndAt = nowMs()
      state.currentTurn.speechBytes = sentBytes
      state.currentTurn.speechSeconds = speechSeconds
    }

    ui.log(
      `[voice] sent speech segment bytes=${sentBytes} seconds=${speechSeconds.toFixed(2)}`,
    )
  }

  function sendEndOfTurn() {
    wsClient.sendJson({
      type: 'end_of_turn',
      conversationId: state.conversationId,
    })

    setState('waiting_reply')
    ui.log('[voice] end_of_turn sent')
  }

  function handleSocketMessage(data) {
    ui.log(`[voice] recv: ${data.type}`)

    switch (data.type) {
      case 'session_start':
        handleSessionStart(data)
        return

      case 'stt_partial':
        handleSttPartial(data)
        return

      case 'stt_final':
        handleSttFinal(data)
        return

      case 'assistant_text_delta':
        handleAssistantTextDelta(data)
        return

      case 'assistant_audio_chunk':
        handleAssistantAudioChunk(data)
        return

      case 'assistant_final':
        handleAssistantFinal(data)
        return

      case 'turn_end':
        handleTurnEnd()
        return

      case 'error':
        handleVoiceError(data)
        return

      default:
        return
    }
  }

  function handleSessionStart(data) {
    state.currentSessionId = data.sessionId || ''
    ui.setSessionId(state.currentSessionId)

    if (state.currentTurn) {
      state.currentTurn.sessionId = state.currentSessionId
    }

    if (data.conversationId) {
      state.conversationId = data.conversationId
      ui.setConversationId(state.conversationId)

      if (state.currentTurn) {
        state.currentTurn.conversationId = state.conversationId
      }
    }
  }

  function handleSttPartial(data) {
    ui.setPartial(data.full || data.text || '')
  }

  function handleSttFinal(data) {
    state.finalReceivedForCurrentTurn = true
    ui.setPartial('')

    const transcript = (data.full || data.text || '').trim()

    if (state.currentTurn) {
      state.currentTurn.transcript = transcript
      state.currentTurn.sttFinalAt = nowMs()
    }

    ui.log(
      `[metrics] stt_final transcript_len=${transcript.length} ` +
      `ws_open_to_stt=${state.currentTurn?.wsOpenAt ? formatMs(nowMs() - state.currentTurn.wsOpenAt) : '-'}`,
    )

    state.currentUserMessage = ui.createMessage('user', transcript)
    setState('waiting_assistant')
  }

  function handleAssistantTextDelta(data) {
    appendAssistantDelta(data.delta || '', data.full || '')

    if (state.currentTurn && state.currentTurn.assistantFirstDeltaAt == null) {
      state.currentTurn.assistantFirstDeltaAt = nowMs()
    }

    if (state.state !== 'speaking') {
      setState('assistant_streaming')
    }
  }

  function handleAssistantAudioChunk(data) {
    const message = ensureAssistantMessage()

    player.enqueue(
      message,
      data.audioBase64 || '',
      data.chunkIndex ?? 0,
      Boolean(data.isLastChunk),
    )

    if (state.currentTurn && state.currentTurn.assistantFirstAudioAt == null) {
      state.currentTurn.assistantFirstAudioAt = nowMs()
    }

    setState('speaking')
  }

  function handleAssistantFinal(data) {
    const message = ensureAssistantMessage()
    message.textEl.textContent = data.text || ''

    if (state.currentTurn) {
      state.currentTurn.reply = data.text || ''

      if (state.currentTurn.assistantFinalAt == null) {
        state.currentTurn.assistantFinalAt = nowMs()
      }
    }

    setState('assistant_ready')
  }

  function handleTurnEnd() {
    ui.log('[voice] turn complete')

    if (state.currentTurn) {
      state.currentTurn.turnEndAt = nowMs()
      ui.pushMetricsRow(state.currentTurn)
      logTurnMetrics(state.currentTurn)
    }

    cleanupTurnSocket()
    setState(state.listeningArmed ? 'armed_listening' : 'idle')
  }

  function logTurnMetrics(turn) {
    const captureToOpenMs =
      turn.wsOpenAt && turn.speechCapturedAt
        ? turn.wsOpenAt - turn.speechCapturedAt
        : null

    const uploadMs =
      turn.audioSendEndAt && turn.audioSendStartAt
        ? turn.audioSendEndAt - turn.audioSendStartAt
        : null

    const sttMs =
      turn.sttFinalAt && turn.speechCapturedAt
        ? turn.sttFinalAt - turn.speechCapturedAt
        : null

    const firstTextMs =
      turn.assistantFirstDeltaAt && turn.sttFinalAt
        ? turn.assistantFirstDeltaAt - turn.sttFinalAt
        : null

    const firstAudioMs =
      turn.assistantFirstAudioAt && turn.sttFinalAt
        ? turn.assistantFirstAudioAt - turn.sttFinalAt
        : null

    const completeMs =
      turn.assistantFinalAt && turn.sttFinalAt
        ? turn.assistantFinalAt - turn.sttFinalAt
        : null

    const totalMs =
      turn.turnEndAt && turn.speechCapturedAt
        ? turn.turnEndAt - turn.speechCapturedAt
        : null

    ui.log(
      `[metrics] turn=${turn.index} ` +
      `capture_to_open=${formatMs(captureToOpenMs)} ` +
      `upload=${formatMs(uploadMs)} ` +
      `stt=${formatMs(sttMs)} ` +
      `first_text=${formatMs(firstTextMs)} ` +
      `first_audio=${formatMs(firstAudioMs)} ` +
      `complete=${formatMs(completeMs)} ` +
      `total=${formatMs(totalMs)} ` +
      `bytes=${turn.speechBytes} ` +
      `seconds=${turn.speechSeconds.toFixed(2)}`,
    )
  }

  function handleVoiceError(data) {
    const msg = data.message || 'unknown'
    const ignorableBufferError =
      msg.includes('buffer too small') && state.finalReceivedForCurrentTurn

    if (ignorableBufferError) {
      ui.log(`[voice] ignored benign error: ${msg}`)
      return
    }

    ui.log(`[voice] server error: ${msg}`)
    cleanupTurnSocket()
    setState(state.listeningArmed ? 'armed_listening' : 'error')
  }

  function handleSocketClose() {
    ui.log('[voice] closed')
  }

  function handleSocketError(error) {
    ui.log('[voice] error')
    console.error(error)
  }

  function cleanupTurnSocket() {
    wsClient.close()
    state.currentSessionId = ''
    ui.setSessionId('')

    state.suppressAutoListenUntil = Math.max(
      state.suppressAutoListenUntil,
      nowMs() + config.ASSISTANT_PLAYBACK_GRACE_MS,
    )
  }

  async function startSession() {
    if (state.listeningArmed) return

    try {
      await vadClient.start()
      state.listeningArmed = true
      setState('armed_listening')
      ui.log('session armed')
    } catch (error) {
      console.error(error)
      ui.log(`start session failed: ${String(error)}`)
      setState('error')
    }
  }

  async function stopSession() {
    state.listeningArmed = false
    state.assistantAudioPlaying = false
    state.suppressAutoListenUntil = 0

    await vadClient.pause()
    cleanupTurnSocket()
    player.clear()

    setState('idle')
    ui.log('session stopped')
  }

  function startNewConversation() {
    state.conversationId = crypto.randomUUID()
    state.currentSessionId = ''
    state.currentUserMessage = null
    state.currentAssistantMessage = null
    state.turnCounter = 0
    state.currentTurn = null
    state.finalReceivedForCurrentTurn = false
    state.suppressAutoListenUntil = 0
    state.assistantAudioPlaying = false

    player.clear()
    ui.resetConversation(state)
    ui.log('new conversation created')
  }

  return {
    init,
  }
}
