<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'

type LoginResponse = {
  accessToken: string
  user: {
    id: string
    email: string
    name: string
  }
}

type PortalState = {
  tenant: { id: string; name: string }
  site: { id: string; name: string; mode: string }
  zones: Array<{
    id: string
    name: string
    sensors: Array<{
      id: string
      name: string
      capability: string
      value: number | boolean | null
      unit?: string
      observedAt: string
      source: string
    }>
  }>
  voice: { websocketPath: string; provider: string }
}

type VoiceConfig = {
  sttProvider: string
  openaiBatchModel: string
  localWhisperFallbackToOpenAI: boolean
  localWhisperWorker?: boolean
  localWhisperModel: string
  localWhisperLanguage: string
}

const tokenKey = 'energrid.portal.token'
const userKey = 'energrid.portal.user'
const themeKey = 'energrid.portal.theme.v2'

function cleanBaseUrl(url: string) {
  return url.replace(/\/$/, '')
}

function voiceUrlFromApiBase(baseUrl: string) {
  if (!baseUrl) return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/voice`
  const url = new URL('/voice', baseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

const apiBase = cleanBaseUrl(
  import.meta.env.VITE_API_BASE_URL || '',
)
const defaultWsBase = import.meta.env.VITE_VOICE_WS_URL || voiceUrlFromApiBase(apiBase)

const email = ref('admin@energrid.local')
const password = ref('admin123')
const loginError = ref('')
const accessToken = ref(localStorage.getItem(tokenKey) || '')
const user = ref<LoginResponse['user'] | null>(
  localStorage.getItem(userKey)
    ? JSON.parse(localStorage.getItem(userKey) || 'null')
    : null,
)
const state = ref<PortalState | null>(null)
const loadingState = ref(false)
const stateError = ref('')

const wsUrl = ref(defaultWsBase)
const voiceStatus = ref('idle')
const transcript = ref('')
const assistant = ref('')
const plan = ref('')
const eventLog = ref<string[]>([])
const metrics = ref<Record<string, unknown> | null>(null)
const connected = ref(false)
const recording = ref(false)
const theme = ref(localStorage.getItem(themeKey) || 'dark')
const userMenuOpen = ref(false)
const notificationsOpen = ref(false)
const mobileMenuOpen = ref(false)

const navItems = [
  { id: 'overview', label: 'Overview', active: true },
  { id: 'voice', label: 'Voice', active: false },
  { id: 'devices', label: 'Devices', active: false },
  { id: 'automations', label: 'Automations', active: false },
  { id: 'logs', label: 'Logs', active: false },
]

const notifications = [
  { tone: 'green', text: 'Kitchen temperature sensor online' },
  { tone: 'blue', text: 'Voice gateway ready' },
  { tone: 'amber', text: 'Local STT can be slow on Pi CPU' },
]

let ws: WebSocket | null = null
let audioContext: AudioContext | null = null
let mediaStream: MediaStream | null = null
let source: MediaStreamAudioSourceNode | null = null
let processor: ScriptProcessorNode | null = null
let pcmQueue: number[] = []

const sampleRate = 16000
const flushSamples = 4096

const userInitials = computed(() => {
  const name = user.value?.name || user.value?.email || 'EG'
  return name
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('')
})

const displayLogs = computed(() => eventLog.value.slice(-8))
const serverLabel = computed(() => import.meta.env.VITE_BACKEND_LABEL || apiBase || 'same-origin')

async function login() {
  loginError.value = ''
  const response = await fetch(`${apiBase}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email.value, password: password.value }),
  })

  if (!response.ok) {
    loginError.value = 'Invalid credentials'
    return
  }

  const data = (await response.json()) as LoginResponse
  accessToken.value = data.accessToken
  user.value = data.user
  localStorage.setItem(tokenKey, data.accessToken)
  localStorage.setItem(userKey, JSON.stringify(data.user))
  await loadState()
}

function logout() {
  disconnectVoice()
  userMenuOpen.value = false
  notificationsOpen.value = false
  mobileMenuOpen.value = false
  accessToken.value = ''
  user.value = null
  state.value = null
  localStorage.removeItem(tokenKey)
  localStorage.removeItem(userKey)
}

function toggleTheme() {
  theme.value = theme.value === 'light' ? 'dark' : 'light'
  localStorage.setItem(themeKey, theme.value)
}

function toggleNotifications() {
  notificationsOpen.value = !notificationsOpen.value
  userMenuOpen.value = false
}

function toggleUserMenu() {
  userMenuOpen.value = !userMenuOpen.value
  notificationsOpen.value = false
}

function closeMobileMenu() {
  mobileMenuOpen.value = false
}

async function loadState() {
  loadingState.value = true
  stateError.value = ''
  try {
    appendLog(`[portal] loading state from ${serverLabel.value}`)
    const response = await fetch(`${apiBase}/portal/state`, {
      headers: { Authorization: `Bearer ${accessToken.value}` },
    })
    if (response.status === 404) {
      await loadVoiceOnlyState()
      return
    }
    if (!response.ok) throw new Error('State unavailable')
    state.value = (await response.json()) as PortalState
  } catch (error) {
    stateError.value = error instanceof Error ? error.message : 'State unavailable'
  } finally {
    loadingState.value = false
  }
}

async function loadVoiceOnlyState() {
  appendLog('[portal] /portal/state missing, using /voice/config fallback')
  const response = await fetch(`${apiBase}/voice/config`)
  if (!response.ok) throw new Error('Voice config unavailable')
  const config = (await response.json()) as VoiceConfig

  state.value = {
    tenant: { id: 'tenant-live', name: 'Energrid Live' },
    site: { id: 'site-pi', name: 'Home', mode: 'home' },
    zones: [],
    voice: {
      websocketPath: '/voice',
      provider: config.sttProvider,
    },
  }
}

function resetTurn() {
  transcript.value = ''
  assistant.value = ''
  plan.value = ''
  metrics.value = null
}

function appendLog(message: string) {
  const time = new Date().toLocaleTimeString()
  eventLog.value.push(`${time} ${message}`)
}

function connectVoice() {
  if (ws?.readyState === WebSocket.OPEN) return Promise.resolve()
  if (ws?.readyState === WebSocket.CONNECTING) {
    return new Promise<void>((resolve, reject) => {
      ws?.addEventListener('open', () => resolve(), { once: true })
      ws?.addEventListener('error', () => reject(new Error('Voice socket failed')), { once: true })
    })
  }

  appendLog('[voice] connecting')
  ws = new WebSocket(wsUrl.value)
  ws.binaryType = 'arraybuffer'
  attachVoiceListeners(ws)
  voiceStatus.value = 'connecting'

  return new Promise<void>((resolve, reject) => {
    ws?.addEventListener('open', () => {
      connected.value = true
      voiceStatus.value = 'connected'
      appendLog('[voice] connected')
      resolve()
    }, { once: true })

    ws?.addEventListener('error', () => {
      voiceStatus.value = 'socket error'
      appendLog('[voice] socket error')
      reject(new Error('Voice socket failed'))
    }, { once: true })
  })
}

function attachVoiceListeners(socket: WebSocket) {
  socket.addEventListener('close', () => {
    connected.value = false
    voiceStatus.value = 'closed'
    ws = null
    appendLog('[voice] closed')
  })

  socket.addEventListener('error', () => {
    voiceStatus.value = 'socket error'
    appendLog('[voice] socket error')
  })

  socket.addEventListener('message', (message) => {
    const event = JSON.parse(message.data)
    appendLog(JSON.stringify(redactAudio(event)))

    if (event.type === 'stt_final') transcript.value = event.full || event.text || ''
    if (event.type === 'assistant_text_delta') assistant.value = event.full || ''
    if (event.type === 'assistant_final') assistant.value = event.text || ''
    if (event.type === 'home_action_plan') plan.value = JSON.stringify(event.plan, null, 2)
    if (event.type === 'assistant_audio_chunk') playAudioBase64(event.audioBase64, event.format)
    if (event.type === 'turn_end') {
      metrics.value = event.metrics || null
      voiceStatus.value = 'turn complete'
    }
    if (event.type === 'error') voiceStatus.value = `error: ${event.message}`
  })
}

function disconnectVoice() {
  appendLog('[voice] disconnect requested')
  ws?.close()
  ws = null
  connected.value = false
}

function redactAudio(event: Record<string, any>) {
  if (event.type !== 'assistant_audio_chunk') return event
  return {
    ...event,
    audioBase64: `<${Math.round((event.audioBase64 || '').length / 1024)}KB base64>`,
  }
}

async function startRecording(event?: PointerEvent) {
  event?.preventDefault()
  if (event?.currentTarget instanceof HTMLElement) {
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  try {
    await connectVoice()
  } catch {
    return
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  resetTurn()
  pcmQueue = []
  recording.value = true
  voiceStatus.value = 'recording'
  appendLog('[audio] recording started')

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
    if (!recording.value || !ws || ws.readyState !== WebSocket.OPEN || !audioContext) return
    const input = event.inputBuffer.getChannelData(0)
    const pcm16 = resampleToPcm16(input, audioContext.sampleRate, sampleRate)
    enqueueAndFlush(pcm16)
  }
  source.connect(processor)
  processor.connect(audioContext.destination)
}

async function stopRecording(event?: PointerEvent) {
  event?.preventDefault()
  if (event?.currentTarget instanceof HTMLElement && event.currentTarget.hasPointerCapture(event.pointerId)) {
    event.currentTarget.releasePointerCapture(event.pointerId)
  }
  if (!recording.value) return
  recording.value = false
  voiceStatus.value = 'sending'
  flushPcm(true)
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'end_of_turn' }))
    appendLog('[audio] released, turn sent')
  }
  await cleanupAudio()
}

function enqueueAndFlush(pcm16: Int16Array) {
  for (const sample of pcm16) pcmQueue.push(sample)
  flushPcm(false)
}

function flushPcm(force: boolean) {
  while (ws && (pcmQueue.length >= flushSamples || (force && pcmQueue.length > 0))) {
    const size = force ? pcmQueue.length : flushSamples
    const chunk = new Int16Array(pcmQueue.splice(0, size))
    ws.send(chunk.buffer)
  }
}

function resampleToPcm16(input: Float32Array, inputRate: number, outputRate: number) {
  if (inputRate === outputRate) return floatToPcm16(input)
  const ratio = inputRate / outputRate
  const outputLength = Math.floor(input.length / ratio)
  const output = new Float32Array(outputLength)
  for (let i = 0; i < outputLength; i += 1) {
    output[i] = input[Math.min(input.length - 1, Math.floor(i * ratio))]
  }
  return floatToPcm16(output)
}

function floatToPcm16(input: Float32Array) {
  const output = new Int16Array(input.length)
  for (let i = 0; i < input.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, input[i]))
    output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
  }
  return output
}

async function cleanupAudio() {
  processor?.disconnect()
  source?.disconnect()
  mediaStream?.getTracks().forEach((track) => track.stop())
  await audioContext?.close()
  processor = null
  source = null
  mediaStream = null
  audioContext = null
}

function playAudioBase64(base64: string, format = 'wav') {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
  const blob = new Blob([bytes], { type: `audio/${format}` })
  const audio = new Audio(URL.createObjectURL(blob))
  audio.play().catch(() => undefined)
}

if (accessToken.value && user.value) {
  loadState()
}

onBeforeUnmount(() => {
  disconnectVoice()
  cleanupAudio()
})
</script>

<template>
  <main v-if="!accessToken" :class="['login-screen', `theme-${theme}`]">
    <section class="login-panel">
      <div class="brand-lockup large">
        <img class="brand-logo" src="/images/energrid-logo-symbol.png" alt="" />
        <div class="brand-copy">
          <h1>Energrid</h1>
          <span>Бъдещето е тук</span>
        </div>
      </div>
      <p class="login-lead">Smart automation command center</p>
      <div class="field">
        <label for="email">Email</label>
        <input id="email" v-model="email" autocomplete="username" />
      </div>
      <div class="field">
        <label for="password">Password</label>
        <input id="password" v-model="password" autocomplete="current-password" type="password" @keydown.enter="login" />
      </div>
      <button class="primary wide" @click="login">Sign in</button>
      <p class="error">{{ loginError }}</p>
    </section>
  </main>

  <main v-else :class="['admin-shell', `theme-${theme}`, { 'menu-open': mobileMenuOpen }]">
    <header class="mobile-appbar">
      <button class="menu-button" type="button" aria-label="Open navigation" @click="mobileMenuOpen = true">
        <span></span>
        <span></span>
        <span></span>
      </button>
      <div class="brand-lockup">
        <img class="brand-logo" src="/images/energrid-logo-symbol.png" alt="" />
        <div class="brand-copy">
          <strong>Energrid</strong>
          <span>Бъдещето е тук</span>
        </div>
      </div>
      <div class="mobile-actions">
        <div class="notification-area">
          <button class="icon-button" type="button" aria-label="Notifications" @click="toggleNotifications">
            <span aria-hidden="true">●</span>
          </button>
          <div v-if="notificationsOpen" class="popover notification-popover">
            <strong>Notifications</strong>
            <ul>
              <li v-for="notification in notifications" :key="notification.text">
                <span :class="['dot', notification.tone]"></span>
                {{ notification.text }}
              </li>
            </ul>
          </div>
        </div>
        <button class="icon-button" type="button" :aria-label="theme === 'light' ? 'Use dark theme' : 'Use light theme'" @click="toggleTheme">
          <span aria-hidden="true">{{ theme === 'light' ? '☾' : '☼' }}</span>
        </button>
        <button class="avatar-button mobile-avatar" type="button" aria-label="Account menu" @click="toggleUserMenu">
          <span>{{ userInitials }}</span>
        </button>
      </div>
    </header>

    <button
      v-if="mobileMenuOpen"
      class="drawer-backdrop"
      type="button"
      aria-label="Close navigation"
      @click="closeMobileMenu"
    ></button>

    <aside class="sidebar">
      <button class="drawer-close" type="button" aria-label="Close navigation" @click="closeMobileMenu">×</button>
      <div class="brand-lockup">
        <img class="brand-logo" src="/images/energrid-logo-symbol.png" alt="" />
        <div class="brand-copy">
          <strong>Energrid</strong>
          <span>Бъдещето е тук</span>
        </div>
      </div>

      <nav class="side-nav" aria-label="Portal navigation">
        <button
          v-for="item in navItems"
          :key="item.label"
          :class="{ active: item.active }"
          type="button"
          @click="closeMobileMenu"
        >
          <span class="nav-icon" aria-hidden="true">
            <svg v-if="item.id === 'overview'" viewBox="0 0 24 24">
              <path d="M4 11.5 12 5l8 6.5" />
              <path d="M7 10.5V19h10v-8.5" />
            </svg>
            <svg v-else-if="item.id === 'voice'" viewBox="0 0 24 24">
              <path d="M12 5v8" />
              <path d="M8 10a4 4 0 0 0 8 0" />
              <path d="M5 10a7 7 0 0 0 14 0" />
              <path d="M12 17v3" />
            </svg>
            <svg v-else-if="item.id === 'devices'" viewBox="0 0 24 24">
              <path d="M6 6h5v5H6zM13 6h5v5h-5zM6 13h5v5H6zM13 13h5v5h-5z" />
            </svg>
            <svg v-else-if="item.id === 'automations'" viewBox="0 0 24 24">
              <path d="M6 7h5l2 10h5" />
              <path d="M6 17h5l2-10h5" />
              <path d="M4 7h2M18 7h2M4 17h2M18 17h2" />
            </svg>
            <svg v-else viewBox="0 0 24 24">
              <path d="M7 7h10M7 12h10M7 17h10" />
            </svg>
          </span>
          <span>{{ item.label }}</span>
        </button>
      </nav>

      <section class="side-card">
        <span>Current site</span>
        <strong>{{ state?.site.name || 'Home' }}</strong>
        <small>{{ state?.tenant.name || 'Energrid Demo' }}</small>
      </section>
    </aside>

    <section class="app-main">
      <header class="topbar">
        <div class="top-actions">
          <div class="notification-area">
            <button class="icon-button" type="button" aria-label="Notifications" @click="toggleNotifications">
              <span aria-hidden="true">●</span>
            </button>
            <div v-if="notificationsOpen" class="popover notification-popover">
              <strong>Notifications</strong>
              <ul>
                <li v-for="notification in notifications" :key="notification.text">
                  <span :class="['dot', notification.tone]"></span>
                  {{ notification.text }}
                </li>
              </ul>
            </div>
          </div>
          <button class="icon-button" type="button" :aria-label="theme === 'light' ? 'Use dark theme' : 'Use light theme'" @click="toggleTheme">
            <span aria-hidden="true">{{ theme === 'light' ? '☾' : '☼' }}</span>
          </button>
          <div class="user-menu">
            <button class="avatar-button" type="button" aria-label="Account menu" @click="toggleUserMenu">
              <span>{{ userInitials }}</span>
            </button>
            <div v-if="userMenuOpen" class="popover user-popover">
              <strong>{{ user?.name }}</strong>
              <span>{{ user?.email }}</span>
              <button class="secondary wide" type="button" @click="logout">Sign out</button>
            </div>
          </div>
        </div>
      </header>

      <section class="workspace">
        <section class="panel assistant-panel premium-panel">
          <div class="assistant-heading">
            <div>
              <p class="eyebrow">Energrid Assistant</p>
              <h2>Ask once. Let the site respond safely.</h2>
              <span>Hold the button, speak naturally, release to send the turn.</span>
            </div>
            <div class="voice-orb" :class="{ listening: recording }">
              <span>{{ recording ? 'REC' : 'AI' }}</span>
            </div>
          </div>

          <div class="assistant-status-row">
            <span><span class="dot green"></span>{{ connected ? 'connected' : 'offline' }}</span>
            <span>API {{ serverLabel }}</span>
            <span>STT {{ state?.voice.provider || '--' }}</span>
            <span>{{ voiceStatus }}</span>
          </div>

          <div class="talk-stage">
            <button
              class="primary talk-button"
              :class="{ recording }"
              @pointerdown="startRecording"
              @pointerup="stopRecording"
              @pointercancel="stopRecording"
              @lostpointercapture="stopRecording"
            >
              <span>{{ recording ? 'Release to send' : voiceStatus === 'connecting' ? 'Connecting' : 'Hold to talk' }}</span>
              <small>{{ recording ? 'Listening now' : 'Press and hold' }}</small>
            </button>
          </div>

          <div class="conversation">
            <div>
              <span>Transcript</span>
              <p>{{ transcript || 'Waiting for your command' }}</p>
            </div>
            <div>
              <span>Assistant</span>
              <p>{{ assistant || 'Ready to translate intent into a safe plan' }}</p>
            </div>
          </div>

          <div class="voice-log">
            <div class="section-row">
              <h2>Live log</h2>
              <span>{{ displayLogs.length }} entries</span>
            </div>
            <pre>{{ displayLogs.join('\n') || 'Hold the button to start a voice turn.' }}</pre>
          </div>
        </section>

        <p v-if="stateError" class="error">{{ stateError }}</p>
      </section>
    </section>
  </main>
</template>
