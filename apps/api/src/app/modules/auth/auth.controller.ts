import { Body, Controller, Get, Headers, Post, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { AuthConfig } from './auth-config'
import { AuthService } from './auth.service'
import { AccessJwtGuard, requirePrincipal } from './auth.guard'
import type { AuthenticatedRequest } from './auth.types'

interface AuthHttpRequest extends AuthenticatedRequest {
  ip?: string
  headers: AuthenticatedRequest['headers'] & { origin?: string; cookie?: string }
}
interface AuthHttpResponse {
  cookie(name: string, value: string, options: Record<string, unknown>): void
  clearCookie(name: string, options: Record<string, unknown>): void
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService, private readonly config: AuthConfig) {}

  @Post('login')
  async login(@Body() body: unknown, @Req() request: AuthHttpRequest, @Res({ passthrough: true }) response: AuthHttpResponse) {
    validateOrigin(request, this.config)
    const result = await this.auth.login(body, request.ip || null)
    setSessionCookies(response, this.config, result.session.refreshToken, result.session.idleExpiresAt)
    setCsrfCookie(response, this.config)
    return { accessToken: result.accessToken, tokenType: 'Bearer', expiresIn: this.auth.accessLifetimeSeconds, user: result.user }
  }

  @Post('refresh')
  async refresh(@Req() request: AuthHttpRequest, @Headers('x-csrf-token') csrfHeader: string | undefined,
    @Res({ passthrough: true }) response: AuthHttpResponse) {
    validateOrigin(request, this.config)
    validateCsrf(request, csrfHeader, this.config)
    const result = await this.auth.refresh(readRequestCookie(request, refreshCookieName(this.config)), request.ip || null)
    setSessionCookies(response, this.config, result.refreshToken, result.session.idleExpiresAt)
    setCsrfCookie(response, this.config)
    return { accessToken: result.accessToken, tokenType: 'Bearer', expiresIn: this.auth.accessLifetimeSeconds, user: result.user }
  }

  @Post('logout')
  @UseGuards(AccessJwtGuard)
  async logout(@Req() request: AuthHttpRequest, @Headers('x-csrf-token') csrfHeader: string | undefined,
    @Res({ passthrough: true }) response: AuthHttpResponse) {
    validateOrigin(request, this.config)
    validateCsrf(request, csrfHeader, this.config)
    await this.auth.logout(requirePrincipal(request), request.ip || null)
    clearSessionCookies(response, this.config)
    return { ok: true }
  }

  @Post('logout-all')
  @UseGuards(AccessJwtGuard)
  async logoutAll(@Req() request: AuthHttpRequest, @Headers('x-csrf-token') csrfHeader: string | undefined,
    @Res({ passthrough: true }) response: AuthHttpResponse) {
    validateOrigin(request, this.config)
    validateCsrf(request, csrfHeader, this.config)
    await this.auth.logoutAll(requirePrincipal(request), request.ip || null)
    clearSessionCookies(response, this.config)
    return { ok: true }
  }

  @Get('me')
  @UseGuards(AccessJwtGuard)
  me(@Req() request: AuthenticatedRequest) {
    const user = requirePrincipal(request)
    return { user: { id: user.userId, email: user.email, name: user.name, role: user.role } }
  }
}

export function refreshCookieName(config: AuthConfig): string { return config.value.production ? '__Host-energrid_refresh' : 'energrid_refresh' }
export function csrfCookieName(config: AuthConfig): string { return config.value.production ? '__Host-energrid_csrf' : 'energrid_csrf' }

function cookieOptions(config: AuthConfig, expires: Date) {
  return { httpOnly: true, secure: config.value.production, sameSite: 'lax' as const,
    path: '/', expires }
}

function setSessionCookies(response: AuthHttpResponse, config: AuthConfig, token: string, expires: Date) {
  response.cookie(refreshCookieName(config), token, cookieOptions(config, expires))
}
function setCsrfCookie(response: AuthHttpResponse, config: AuthConfig) {
  const expires = new Date(Date.now() + 30 * 86400_000)
  response.cookie(csrfCookieName(config), randomBytes(32).toString('base64url'), {
    httpOnly: false, secure: config.value.production, sameSite: 'lax',
    path: '/', expires,
  })
}
function clearSessionCookies(response: AuthHttpResponse, config: AuthConfig) {
  const options = { httpOnly: true, secure: config.value.production, sameSite: 'lax' as const, path: '/' }
  response.clearCookie(refreshCookieName(config), options)
  response.clearCookie(csrfCookieName(config), { ...options, httpOnly: false })
}

function validateOrigin(request: AuthHttpRequest, config: AuthConfig): void {
  const origin = request.headers.origin
  if (!origin || !config.value.trustedOrigins.has(origin)) throw new UnauthorizedException('Untrusted browser origin')
}
function validateCsrf(request: AuthHttpRequest, header: string | undefined, config: AuthConfig): void {
  const cookie = readRequestCookie(request, csrfCookieName(config))
  if (!cookie || !header || !/^[A-Za-z0-9_-]{43}$/.test(cookie) || !/^[A-Za-z0-9_-]{43}$/.test(header) || !safeEqual(cookie, header)) {
    throw new UnauthorizedException('CSRF validation failed')
  }
}
function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a,b)
}
export function readRequestCookie(request: { headers: { cookie?: string } }, name: string): string | undefined {
  const header = request.headers.cookie
  if (!header) return undefined
  for (const item of header.split(';')) {
    const [key, ...parts] = item.trim().split('=')
    if (key === name) { try { return decodeURIComponent(parts.join('=')) } catch { return undefined } }
  }
  return undefined
}
