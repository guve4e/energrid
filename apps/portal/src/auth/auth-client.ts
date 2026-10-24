type SafeUser = { id: string; email: string; name: string; role: 'admin' | 'installer' | 'viewer' }
type TokenResponse = { accessToken: string; expiresIn: number; user: SafeUser }

const apiBase = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')
const apiOrigin = new URL(apiBase || '/', window.location.origin).origin
let accessToken = ''
let expiresAt = 0
let refreshPromise: Promise<boolean> | null = null
const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('energrid-auth-v1')
const listeners = new Set<(user: SafeUser | null) => void>()

channel?.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { type?: string; token?: string; expiresAt?: number; user?: SafeUser } | null
  if (data?.type === 'session' && typeof data.token === 'string' && typeof data.expiresAt === 'number') {
    setSession(data.token, data.expiresAt, data.user || null, false)
  } else if (data?.type === 'logout') {
    clearSession(false)
  }
})

export function getAccessToken(): string { return accessToken }
export function onAuthState(listener: (user: SafeUser | null) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function setAuthenticatedSession(result: TokenResponse): void {
  setSession(result.accessToken, Date.now() + result.expiresIn * 1000, result.user, true)
}

export function clearAuthenticatedSession(broadcast = true): void { clearSession(broadcast) }

export async function restoreSession(): Promise<SafeUser | null> {
  const ok = await refresh()
  if (!ok) return null
  const response = await rawFetch(`${apiBase}/auth/me`, {
    method: 'GET', headers: { Authorization: `Bearer ${accessToken}` }, credentials: 'include',
  })
  if (!response.ok) { clearSession(true); return null }
  const body = await response.json() as { user: SafeUser }
  notify(body.user)
  return body.user
}

export async function authFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url, window.location.origin)
  if (url.origin !== apiOrigin) return rawFetch(input, init)
  const retryInput = input instanceof Request ? input.clone() : input
  const authPath = url.pathname.startsWith('/auth/')
  const headers = new Headers(init.headers || (typeof input !== 'string' && !(input instanceof URL) ? input.headers : undefined))
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`)
  const requestInit: RequestInit = { ...init, headers, credentials: 'include' }
  let response = await rawFetch(input, requestInit)
  if (response.status !== 401 || authPath || !accessToken) return response
  const failedToken = accessToken
  if (!await refresh(failedToken)) {
    clearSession(true)
    window.dispatchEvent(new CustomEvent('energrid:auth-expired'))
    return response
  }
  headers.set('Authorization', `Bearer ${accessToken}`)
  response = await rawFetch(retryInput, { ...requestInit, headers })
  if (response.status === 401) {
    clearSession(true)
    window.dispatchEvent(new CustomEvent('energrid:auth-expired'))
  }
  return response
}

export async function logoutRequest(): Promise<void> {
  if ((!accessToken || expiresAt <= Date.now()) && !await refresh(accessToken)) { clearSession(true); return }
  try {
    await authFetch(`${apiBase}/auth/logout`, { method: 'POST', headers: csrfHeaders() })
  } finally { clearSession(true) }
}

async function refresh(staleToken?: string): Promise<boolean> {
  if (refreshPromise) return refreshPromise
  refreshPromise = withCrossTabLock(async () => {
    if (accessToken && accessToken !== staleToken && expiresAt > Date.now() + 5_000) return true
    const csrf = csrfCookie()
    if (!csrf) return false
    const response = await rawFetch(`${apiBase}/auth/refresh`, {
      method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': csrf },
    })
    if (!response.ok) return false
    const result = await response.json() as TokenResponse
    setAuthenticatedSession(result)
    return true
  }).finally(() => { refreshPromise = null })
  return refreshPromise
}

async function withCrossTabLock<T>(operation: () => Promise<T>): Promise<T> {
  if (navigator.locks?.request) return navigator.locks.request('energrid-auth-refresh-v1', { mode: 'exclusive' }, operation)
  const lockKey = 'energrid.auth.refresh.lock'
  const owner = crypto.randomUUID()
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const current = parseLock(localStorage.getItem(lockKey))
    if (!current || current.expiresAt < Date.now()) {
      localStorage.setItem(lockKey, JSON.stringify({ owner, expiresAt: Date.now() + 10_000 }))
      if (parseLock(localStorage.getItem(lockKey))?.owner === owner) {
        try { return await operation() }
        finally { if (parseLock(localStorage.getItem(lockKey))?.owner === owner) localStorage.removeItem(lockKey) }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 100))
  }
  throw new Error('Could not coordinate session refresh across tabs')
}

function parseLock(value: string | null): { owner: string; expiresAt: number } | null {
  if (!value) return null
  try { const parsed = JSON.parse(value); return typeof parsed.owner === 'string' && typeof parsed.expiresAt === 'number' ? parsed : null }
  catch { return null }
}

function csrfCookie(): string {
  const name = document.cookie.split('; ').find((entry) => entry.startsWith('__Host-energrid_csrf=') || entry.startsWith('energrid_csrf='))
  return name ? decodeURIComponent(name.slice(name.indexOf('=') + 1)) : ''
}
function csrfHeaders(): HeadersInit { const token = csrfCookie(); return token ? { 'X-CSRF-Token': token } : {} }
function rawFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> { return window.fetch(input, init) }
function setSession(token: string, expires: number, user: SafeUser | null, broadcast: boolean): void {
  accessToken = token; expiresAt = expires; notify(user)
  if (broadcast) channel?.postMessage({ type: 'session', token, expiresAt: expires, user })
}
function clearSession(broadcast: boolean): void {
  accessToken = ''; expiresAt = 0; notify(null)
  if (broadcast) channel?.postMessage({ type: 'logout' })
}
function notify(user: SafeUser | null): void { for (const listener of listeners) listener(user) }
