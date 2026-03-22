window.createVoiceWsClient = function createVoiceWsClient({ wsUrl, log }) {
  let ws = null

  function connect({ onOpen, onMessage, onClose, onError }) {
    if (ws) {
      throw new Error('WebSocket already exists')
    }

    log?.(`[ws] connecting to ${wsUrl}`)

    ws = new WebSocket(wsUrl)

    ws.onopen = () => {
      log?.('[ws] open')
      onOpen?.()
    }

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        onMessage?.(data)
      } catch (error) {
        log?.(`[ws] failed to parse message: ${String(error)}`)
      }
    }

    ws.onclose = (event) => {
      log?.(`[ws] close code=${event.code} reason=${event.reason || ''}`)
      const prev = ws
      ws = null
      onClose?.(event, prev)
    }

    ws.onerror = (event) => {
      log?.('[ws] error')
      onError?.(event)
    }

    return ws
  }

  function sendBinary(buffer) {
    if (!isOpen()) return
    ws.send(buffer)
  }

  function sendJson(payload) {
    if (!isOpen()) return
    ws.send(JSON.stringify(payload))
  }

  function close() {
    if (!ws) return

    const socket = ws
    ws = null

    if (
      socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING
    ) {
      socket.close()
    }
  }

  function isOpen() {
    return !!ws && ws.readyState === WebSocket.OPEN
  }

  function hasSocket() {
    return !!ws
  }

  return {
    connect,
    sendBinary,
    sendJson,
    close,
    isOpen,
    hasSocket,
  }
}
