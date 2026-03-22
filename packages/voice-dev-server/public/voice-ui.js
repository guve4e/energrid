window.createVoiceUi = function createVoiceUi() {
  const els = {
    chat: document.getElementById('chat'),
    status: document.getElementById('status'),
    conversationId: document.getElementById('conversationId'),
    sessionId: document.getElementById('sessionId'),
    partial: document.getElementById('partial'),
    vadInfo: document.getElementById('vadInfo'),
    log: document.getElementById('log'),
    metricsBody: document.getElementById('metricsBody'),
    startBtn: document.getElementById('startBtn'),
    stopBtn: document.getElementById('stopBtn'),
    newConversationBtn: document.getElementById('newConversationBtn'),
    clearLogBtn: document.getElementById('clearLogBtn'),
  }

  function log(msg) {
    console.log(msg)
    els.log.textContent += msg + '\n'
    els.log.scrollTop = els.log.scrollHeight
  }

  function setStatus(next) {
    els.status.textContent = next
  }

  function setConversationId(id) {
    els.conversationId.textContent = id || ''
  }

  function setSessionId(id) {
    els.sessionId.textContent = id || ''
  }

  function setPartial(text) {
    els.partial.textContent = text || ''
  }

  function renderVadInfo({
    listeningArmed,
    assistantAudioPlaying,
    suppressRemainingMs,
    state,
    lastSpeechBytes,
    lastSpeechSeconds,
  }) {
    els.vadInfo.textContent =
      `listeningArmed=${Boolean(listeningArmed)}\n` +
      `assistantAudioPlaying=${Boolean(assistantAudioPlaying)}\n` +
      `suppressRemainingMs=${Math.round(suppressRemainingMs || 0)}\n` +
      `state=${state || '-'}\n` +
      `lastSpeechBytes=${lastSpeechBytes ?? '-'}\n` +
      `lastSpeechSeconds=${lastSpeechSeconds != null ? lastSpeechSeconds.toFixed(2) : '-'}`
  }

  function createMessage(role, text = '') {
    const wrapper = document.createElement('div')
    wrapper.className = `message ${role}`

    const roleEl = document.createElement('div')
    roleEl.className = 'message-role'
    roleEl.textContent = role === 'user' ? 'User' : 'Assistant'

    const textEl = document.createElement('div')
    textEl.className = 'message-text'
    textEl.textContent = text

    wrapper.appendChild(roleEl)
    wrapper.appendChild(textEl)
    els.chat.appendChild(wrapper)

    return { wrapper, textEl }
  }

  function formatMs(ms) {
    if (ms == null) return ''
    return `${Math.round(ms)}ms`
  }

  function latencyClass(ms) {
    if (ms == null) return ''
    if (ms < 800) return 'good'
    if (ms < 1800) return 'warn'
    return 'bad'
  }

  function pushMetricsRow(turn) {
    const captureToOpenMs =
      turn.wsOpenAt && turn.speechCapturedAt
        ? turn.wsOpenAt - turn.speechCapturedAt
        : null

    const uploadMs =
      turn.audioSendEndAt && turn.audioSendStartAt
        ? turn.audioSendEndAt - turn.audioSendStartAt
        : null

    const sttMs =
      turn.sttFinalAt && turn.audioSendEndAt
        ? turn.sttFinalAt - turn.audioSendEndAt
        : null

    const llmMs =
      turn.assistantFinalAt && turn.sttFinalAt
        ? turn.assistantFinalAt - turn.sttFinalAt
        : null

    const ttsMs =
      turn.assistantAudioAt && turn.assistantFinalAt
        ? turn.assistantAudioAt - turn.assistantFinalAt
        : null

    const totalMs =
      turn.turnEndAt && turn.speechCapturedAt
        ? turn.turnEndAt - turn.speechCapturedAt
        : null

    const row = document.createElement('tr')
    row.innerHTML = `
      <td>${turn.index}</td>
      <td class="${latencyClass(sttMs)}">${formatMs(sttMs)}</td>
      <td class="${latencyClass(llmMs)}">${formatMs(llmMs)}</td>
      <td class="${latencyClass(ttsMs)}">${formatMs(ttsMs)}</td>
      <td class="${latencyClass(totalMs)}">${formatMs(totalMs)}</td>
      <td>${(turn.transcript || '').slice(0, 80)}</td>
    `
    row.title =
      `capture→open=${formatMs(captureToOpenMs)} | ` +
      `upload=${formatMs(uploadMs)} | ` +
      `stt=${formatMs(sttMs)} | ` +
      `llm=${formatMs(llmMs)} | ` +
      `tts=${formatMs(ttsMs)} | ` +
      `total=${formatMs(totalMs)}`

    els.metricsBody.prepend(row)
  }

  function resetConversation(state) {
    els.chat.innerHTML = ''
    els.partial.textContent = ''
    els.metricsBody.innerHTML = ''
    setConversationId(state.conversationId)
    setSessionId('')
    setStatus(state.listeningArmed ? 'armed_listening' : 'idle')
  }

  function bindButtons({ onStart, onStop, onNewConversation, onClearLog }) {
    els.startBtn.addEventListener('click', onStart)
    els.stopBtn.addEventListener('click', onStop)
    els.newConversationBtn.addEventListener('click', onNewConversation)
    els.clearLogBtn.addEventListener('click', onClearLog)
  }

  return {
    els,
    log,
    setStatus,
    setConversationId,
    setSessionId,
    setPartial,
    renderVadInfo,
    createMessage,
    pushMetricsRow,
    resetConversation,
    bindButtons,
  }
}
