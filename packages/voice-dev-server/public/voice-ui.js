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

  function computeTurnMetrics(turn) {
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

    return {
      captureToOpenMs,
      uploadMs,
      sttMs,
      firstTextMs,
      firstAudioMs,
      completeMs,
      totalMs,
    }
  }

  function pushMetricsRow(turn) {
    const metrics = computeTurnMetrics(turn)

    const row = document.createElement('tr')
    row.innerHTML = `
      <td>${turn.index}</td>
      <td class="${latencyClass(metrics.sttMs)}">${formatMs(metrics.sttMs)}</td>
      <td class="${latencyClass(metrics.firstTextMs)}">${formatMs(metrics.firstTextMs)}</td>
      <td class="${latencyClass(metrics.firstAudioMs)}">${formatMs(metrics.firstAudioMs)}</td>
      <td class="${latencyClass(metrics.completeMs)}">${formatMs(metrics.completeMs)}</td>
      <td class="${latencyClass(metrics.totalMs)}">${formatMs(metrics.totalMs)}</td>
      <td>${(turn.transcript || '').slice(0, 80)}</td>
    `

    row.title =
      `capture_to_open=${formatMs(metrics.captureToOpenMs)} | ` +
      `upload=${formatMs(metrics.uploadMs)} | ` +
      `stt=${formatMs(metrics.sttMs)} | ` +
      `first_text=${formatMs(metrics.firstTextMs)} | ` +
      `first_audio=${formatMs(metrics.firstAudioMs)} | ` +
      `complete=${formatMs(metrics.completeMs)} | ` +
      `total=${formatMs(metrics.totalMs)}`

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

  function bindButtons({
                         onStart,
                         onStop,
                         onNewConversation,
                         onClearLog,
                       }) {
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
    computeTurnMetrics,
  }
}
