import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('Portal auth client', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
    document.cookie = 'energrid_csrf=' + 'x'.repeat(43) + '; path=/'
  })
  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
    document.cookie = 'energrid_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/'
  })

  it('keeps the access token in memory and coordinates one refresh for concurrent expired requests', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/auth/refresh')) return new Response(JSON.stringify({
        accessToken: 'fresh-access-token', expiresIn: 900,
        user: { id: 'u1', email: 'admin@example.test', name: 'Admin', role: 'admin' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      const authorization = new Headers(init?.headers).get('Authorization')
      return authorization === 'Bearer fresh-access-token'
        ? new Response('{}', { status: 200 })
        : new Response('{}', { status: 401 })
    })
    vi.spyOn(window, 'fetch').mockImplementation(fetch as typeof window.fetch)
    const auth = await import('./auth-client')
    auth.setAuthenticatedSession({ accessToken: 'expired-access-token', expiresIn: -1,
      user: { id: 'u1', email: 'admin@example.test', name: 'Admin', role: 'admin' } })

    const [first, second] = await Promise.all([
      auth.authFetch('/portal/state'), auth.authFetch('/portal/state'),
    ])

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(fetch.mock.calls.filter(([input]) => String(input).endsWith('/auth/refresh'))).toHaveLength(1)
    expect(localStorage.getItem('energrid.portal.token')).toBeNull()
    expect(auth.getAccessToken()).toBe('fresh-access-token')
  })

  it('does not retry a forbidden response as an authentication failure', async () => {
    const fetch = vi.fn(async () => new Response('{}', { status: 403 }))
    vi.spyOn(window, 'fetch').mockImplementation(fetch as typeof window.fetch)
    const auth = await import('./auth-client')
    auth.setAuthenticatedSession({ accessToken: 'valid-token', expiresIn: 900,
      user: { id: 'u1', email: 'admin@example.test', name: 'Admin', role: 'admin' } })

    const response = await auth.authFetch('/portal/state')

    expect(response.status).toBe(403)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(auth.getAccessToken()).toBe('valid-token')
  })

  it('refreshes an expired access token before server-side logout', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/auth/refresh')
      ? new Response(JSON.stringify({ accessToken: 'fresh-for-logout', expiresIn: 900,
          user: { id: 'u1', email: 'admin@example.test', name: 'Admin', role: 'admin' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } })
      : new Response('{}', { status: 200 }))
    vi.spyOn(window, 'fetch').mockImplementation(fetch as typeof window.fetch)
    const auth = await import('./auth-client')
    auth.setAuthenticatedSession({ accessToken: 'expired-token', expiresIn: -1,
      user: { id: 'u1', email: 'admin@example.test', name: 'Admin', role: 'admin' } })

    await auth.logoutRequest()

    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual(['/auth/refresh', '/auth/logout'])
    expect(auth.getAccessToken()).toBe('')
  })
})
