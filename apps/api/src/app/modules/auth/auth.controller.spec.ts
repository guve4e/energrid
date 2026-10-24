import { UnauthorizedException } from '@nestjs/common'
import { AuthConfig } from './auth-config'
import { AuthController, csrfCookieName, readRequestCookie, refreshCookieName } from './auth.controller'
import type { AuthService } from './auth.service'

describe('AuthController browser session transport', () => {
  const config = {
    value: { production: false, trustedOrigins: new Set(['http://localhost:4300']) },
  } as AuthConfig
  const principal = { userId: 'u1', email: 'admin@example.test', name: 'Admin', role: 'admin' as const, sessionId: 's1', sessionVersion: 0 }

  function setup() {
    const auth = {
      login: jest.fn().mockResolvedValue({ accessToken: 'short-access', user: { id: 'u1', email: 'admin@example.test', name: 'Admin', role: 'admin' }, session: { id: 's1', refreshToken: 'opaque-refresh-token', idleExpiresAt: new Date(Date.now() + 86400000) } }),
      refresh: jest.fn().mockResolvedValue({ accessToken: 'rotated-access', user: { id: 'u1', email: 'admin@example.test', name: 'Admin', role: 'admin' }, refreshToken: 'rotated-refresh', session: { id: 's1', idleExpiresAt: new Date(Date.now() + 86400000) } }),
      logout: jest.fn(), logoutAll: jest.fn(), accessLifetimeSeconds: 900,
    } as unknown as jest.Mocked<AuthService>
    const controller = new AuthController(auth, config)
    const cookies: Array<{ name: string; value: string; options: Record<string, unknown> }> = []
    const cleared: Array<{ name: string; options: Record<string, unknown> }> = []
    const response = { cookie: (name: string, value: string, options: Record<string, unknown>) => cookies.push({ name, value, options }),
      clearCookie: (name: string, options: Record<string, unknown>) => cleared.push({ name, options }) }
    return { auth, controller, cookies, cleared, response }
  }

  it('returns only the access token and establishes host-only local refresh and readable CSRF cookies', async () => {
    const { controller, cookies, response } = setup()
    const body = await controller.login({ email: 'admin@example.test', password: 'never logged' },
      { headers: { origin: 'http://localhost:4300' }, ip: '127.0.0.1' }, response)

    expect(body).toMatchObject({ accessToken: 'short-access', tokenType: 'Bearer', expiresIn: 900 })
    expect(JSON.stringify(body)).not.toContain('opaque-refresh-token')
    expect(cookies).toHaveLength(2)
    expect(cookies.find(cookie => cookie.name === refreshCookieName(config))?.options).toMatchObject({ httpOnly: true, secure: false, sameSite: 'lax', path: '/' })
    expect(cookies.find(cookie => cookie.name === csrfCookieName(config))?.options).toMatchObject({ httpOnly: false, secure: false, sameSite: 'lax', path: '/' })
  })

  it('uses secure __Host cookies for production', async () => {
    const productionConfig = { value: { ...config.value, production: true } } as AuthConfig
    const auth = { login: jest.fn().mockResolvedValue({ accessToken: 'short', user: { id: 'u1' }, session: { refreshToken: 'opaque', idleExpiresAt: new Date() } }), accessLifetimeSeconds: 900 } as never
    const controller = new AuthController(auth, productionConfig)
    const cookies: Array<{ name: string; options: Record<string, unknown> }> = []
    const response = { cookie: (name: string, _value: string, options: Record<string, unknown>) => cookies.push({ name, options }) }
    await controller.login({ email: 'a', password: 'b' }, { headers: { origin: 'http://localhost:4300' } }, response as never)
    expect(cookies.map(cookie => cookie.name)).toEqual(['__Host-energrid_refresh', '__Host-energrid_csrf'])
    expect(cookies[0].options).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax', path: '/' })
    expect(cookies[1].options).toMatchObject({ httpOnly: false, secure: true, sameSite: 'lax', path: '/' })
  })

  it('rejects untrusted origins and refresh without a matching CSRF header', async () => {
    const { controller } = setup()
    await expect(controller.login({ email: 'a', password: 'b' }, { headers: { origin: 'https://evil.example' } }, {} as never)).rejects.toBeInstanceOf(UnauthorizedException)
    const request = { headers: { origin: 'http://localhost:4300', cookie: `${csrfCookieName(config)}=${'x'.repeat(43)}` } }
    await expect(controller.refresh(request, 'y'.repeat(43), {} as never)).rejects.toThrow('CSRF validation failed')
  })

  it('rotates refresh cookies and requires the double-submit CSRF token for logout', async () => {
    const { auth, controller, cookies, cleared, response } = setup()
    const csrf = 'z'.repeat(43)
    const request = { headers: { origin: 'http://localhost:4300', cookie: `${csrfCookieName(config)}=${csrf}; ${refreshCookieName(config)}=opaque-refresh` }, ip: '127.0.0.1', user: principal }
    const result = await controller.refresh(request, csrf, response)
    expect(result).toMatchObject({ accessToken: 'rotated-access' })
    expect(auth.refresh).toHaveBeenCalledWith('opaque-refresh', '127.0.0.1')
    expect(cookies.some(cookie => cookie.name === refreshCookieName(config) && cookie.value === 'rotated-refresh')).toBe(true)
    await controller.logout(request, csrf, response)
    expect(auth.logout).toHaveBeenCalledWith(principal, '127.0.0.1')
    expect(cleared.map(cookie => cookie.name)).toEqual([refreshCookieName(config), csrfCookieName(config)])
  })

  it('parses only the named cookie without confusing prefix names', () => {
    expect(readRequestCookie({ headers: { cookie: 'x_energrid_refresh=wrong; energrid_refresh=right' } }, 'energrid_refresh')).toBe('right')
  })
})
