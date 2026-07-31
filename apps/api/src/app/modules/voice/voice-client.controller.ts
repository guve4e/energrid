import { Controller, Get, Header } from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'

@ApiExcludeController()
@Controller('voice/client')
export class VoiceClientController {
  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  getClient(): string {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Energrid Voice Client</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #111516; color: #edf2f2; }
    main { max-width: 920px; margin: 0 auto; padding: 28px 18px 42px; }
    h1 { margin: 0 0 18px; font-size: 28px; }
    label { display: block; margin: 14px 0 6px; color: #b8c2c2; font-size: 13px; }
    input { width: 100%; box-sizing: border-box; border: 1px solid #344143; border-radius: 6px; padding: 10px 12px; background: #182022; color: #edf2f2; font-size: 15px; }
    button { border: 0; border-radius: 6px; padding: 10px 14px; margin: 14px 8px 0 0; background: #1fb981; color: #061311; font-weight: 700; cursor: pointer; }
    button.secondary { background: #334144; color: #edf2f2; }
    button:disabled { opacity: .45; cursor: not-allowed; }
    .row { display: grid; grid-template-columns: 1fr; gap: 14px; }
    .panel { margin-top: 18px; border: 1px solid #2c3638; border-radius: 8px; background: #171d1f; padding: 14px; }
    .status { color: #9fc8ba; font-weight: 700; }
    .warn { color: #ffcf70; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 8px 0 0; color: #dce5e5; }
    .events { max-height: 340px; overflow: auto; font-size: 13px; }
    .metric { display: inline-block; margin: 4px 8px 4px 0; color: #c8d7d7; }
  </style>
</head>
<body>
  <main>
    <h1>Energrid Voice Client</h1>
    <div class="panel">
      <div id="secureWarning" class="warn" hidden>Microphone access usually needs HTTPS, or localhost. If this page is opened over plain HTTP from another machine, the browser may block the mic.</div>
      <label for="wsUrl">Voice WebSocket</label>
      <input id="wsUrl" autocomplete="off" />
      <button id="connectBtn">Connect</button>
      <button id="recordBtn" disabled>Hold To Talk</button>
      <button id="disconnectBtn" class="secondary" disabled>Disconnect</button>
      <p>Status: <span id="status" class="status">idle</span></p>
    </div>

    <div class="row">
      <section class="panel">
        <strong>Transcript</strong>
        <pre id="transcript"></pre>
      </section>
      <section class="panel">
        <strong>Assistant</strong>
        <pre id="assistant"></pre>
      </section>
      <section class="panel">
        <strong>Plan</strong>
        <pre id="plan"></pre>
      </section>
      <section class="panel">
        <strong>Metrics</strong>
        <div id="metrics"></div>
      </section>
      <section class="panel events">
        <strong>Events</strong>
        <pre id="events"></pre>
      </section>
    </div>
  </main>

  <script>
    const SAMPLE_RATE = 16000
    const FLUSH_SAMPLES = 4096

    const wsUrlInput = document.getElementById('wsUrl')
    const connectBtn = document.getElementById('connectBtn')
    const disconnectBtn = document.getElementById('disconnectBtn')
    const recordBtn = document.getElementById('recordBtn')
    const statusEl = document.getElementById('status')
    const transcriptEl = document.getElementById('transcript')
    const assistantEl = document.getElementById('assistant')
    const planEl = document.getElementById('plan')
    const metricsEl = document.getElementById('metrics')
    const eventsEl = document.getElementById('events')
    const secureWarning = document.getElementById('secureWarning')

    let ws = null
    let audioContext = null
    let mediaStream = null
    let source = null
    let processor = null
    let pcmQueue = []
    let recording = false

    const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    wsUrlInput.value = wsProtocol + '//' + location.host + '/voice'
    secureWarning.hidden = window.isSecureContext

    function setStatus(value) {
      statusEl.textContent = value
    }

    function logEvent(event) {
      eventsEl.textContent += JSON.stringify(event) + '\\n'
      eventsEl.scrollTop = eventsEl.scrollHeight
    }

    function resetTurnUi() {
      transcriptEl.textContent = ''
      assistantEl.textContent = ''
      planEl.textContent = ''
      metricsEl.textContent = ''
      eventsEl.textContent = ''
    }

    function connect() {
      resetTurnUi()
      ws = new WebSocket(wsUrlInput.value)
      ws.binaryType = 'arraybuffer'
      setStatus('connecting')

      ws.addEventListener('open', () => {
        setStatus('connected')
        connectBtn.disabled = true
        disconnectBtn.disabled = false
        recordBtn.disabled = false
      })

      ws.addEventListener('close', () => {
        setStatus('closed')
        connectBtn.disabled = false
        disconnectBtn.disabled = true
        recordBtn.disabled = true
        ws = null
      })

      ws.addEventListener('error', () => setStatus('socket error'))
      ws.addEventListener('message', (message) => {
        const event = JSON.parse(message.data)
        logEvent(redactAudio(event))

        if (event.type === 'stt_final') transcriptEl.textContent = event.full || event.text || ''
        if (event.type === 'assistant_text_delta') assistantEl.textContent = event.full || ''
        if (event.type === 'assistant_final') assistantEl.textContent = event.text || ''
        if (event.type === 'home_action_plan') planEl.textContent = JSON.stringify(event.plan, null, 2)
        if (event.type === 'assistant_audio_chunk') playAudioBase64(event.audioBase64, event.format)
        if (event.type === 'turn_end') renderMetrics(event.metrics)
        if (event.type === 'error') setStatus('error: ' + event.message)
      })
    }

    function redactAudio(event) {
      if (event.type !== 'assistant_audio_chunk') return event
      return { ...event, audioBase64: '<' + Math.round((event.audioBase64 || '').length / 1024) + 'KB base64>' }
    }

    function renderMetrics(metrics) {
      if (!metrics) return
      const keys = ['totalMs', 'sttMs', 'llmFirstDeltaMs', 'firstAudioMs', 'firstTtsDurationMs', 'ttsTotalMs', 'assistantCompleteMs', 'chunkCount', 'commandFastPath', 'speechGatePassed', 'audioRmsDb', 'audioPeakDb']
      metricsEl.innerHTML = keys.map((key) => '<span class="metric">' + key + ': ' + (metrics[key] ?? '-') + '</span>').join('')
      setStatus('turn complete')
    }

    async function startRecording() {
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      resetTurnUi()
      pcmQueue = []
      recording = true
      recordBtn.textContent = 'Release To Send'
      setStatus('recording')

      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })

      audioContext = new AudioContext()
      source = audioContext.createMediaStreamSource(mediaStream)
      processor = audioContext.createScriptProcessor(4096, 1, 1)
      processor.onaudioprocess = (event) => {
        if (!recording || !ws || ws.readyState !== WebSocket.OPEN) return
        const input = event.inputBuffer.getChannelData(0)
        const pcm16 = resampleToPcm16(input, audioContext.sampleRate, SAMPLE_RATE)
        enqueueAndFlush(pcm16)
      }

      source.connect(processor)
      processor.connect(audioContext.destination)
    }

    async function stopRecording() {
      if (!recording) return
      recording = false
      recordBtn.textContent = 'Hold To Talk'
      setStatus('sending')
      flushPcm(true)
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'end_of_turn' }))
      }
      await cleanupAudio()
    }

    function enqueueAndFlush(pcm16) {
      for (let i = 0; i < pcm16.length; i += 1) pcmQueue.push(pcm16[i])
      flushPcm(false)
    }

    function flushPcm(force) {
      while (pcmQueue.length >= FLUSH_SAMPLES || (force && pcmQueue.length > 0)) {
        const size = force ? pcmQueue.length : FLUSH_SAMPLES
        const chunk = new Int16Array(pcmQueue.splice(0, size))
        ws.send(chunk.buffer)
      }
    }

    function resampleToPcm16(input, inputRate, outputRate) {
      if (inputRate === outputRate) return floatToPcm16(input)
      const ratio = inputRate / outputRate
      const outputLength = Math.floor(input.length / ratio)
      const output = new Float32Array(outputLength)
      for (let i = 0; i < outputLength; i += 1) {
        output[i] = input[Math.min(input.length - 1, Math.floor(i * ratio))]
      }
      return floatToPcm16(output)
    }

    function floatToPcm16(input) {
      const output = new Int16Array(input.length)
      for (let i = 0; i < input.length; i += 1) {
        const sample = Math.max(-1, Math.min(1, input[i]))
        output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
      }
      return output
    }

    async function cleanupAudio() {
      if (processor) processor.disconnect()
      if (source) source.disconnect()
      if (mediaStream) mediaStream.getTracks().forEach((track) => track.stop())
      if (audioContext) await audioContext.close()
      processor = null
      source = null
      mediaStream = null
      audioContext = null
    }

    function playAudioBase64(base64, format) {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
      const blob = new Blob([bytes], { type: 'audio/' + (format || 'wav') })
      const audio = new Audio(URL.createObjectURL(blob))
      audio.play().catch(() => undefined)
    }

    connectBtn.addEventListener('click', connect)
    disconnectBtn.addEventListener('click', () => ws?.close())
    recordBtn.addEventListener('pointerdown', startRecording)
    recordBtn.addEventListener('pointerup', stopRecording)
    recordBtn.addEventListener('pointercancel', stopRecording)
  </script>
</body>
</html>`
  }
}
