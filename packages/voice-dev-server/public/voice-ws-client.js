window.createVoiceWsClient = function createVoiceWsClient({ wsUrl, log }) {
  let ws = null

  function connect({
    onOpen,
    onMessage,
    onClose,
    onError,
  }) {
    ws = new WebSocket(wsUrl)

    ws.onopen = () => onOpen?.()
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data)
      onMessage?.(data)
    }
    ws.onclose = () => {
      onClose?.()
      ws = null
    }
    ws.onerror = (event) => {
      onError?.(event)
    }

    return ws
  }

  function sendBinary(buffer) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(buffer)
  }

  function sendJson(payload) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify(payload))
  }

  function close() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close()
    }
    ws = null
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
