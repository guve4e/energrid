import { HttpException, HttpStatus, Injectable, Logger, UnauthorizedException } from '@nestjs/common'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { AuthConfig } from './auth-config'
import { AccessTokenService } from './access-token.service'
import { AuthRepository } from './auth.repository'
import { PasswordHasher, validatePassword } from './password-hasher'
import type { AuthPrincipal, AuthUser } from './auth.types'

const DUMMY_HASH = '$argon2id$v=19$m=19456,p=1,t=2$UstYPSv3p29B8S0vXlgMuw$Yg+O5fjajK23AH8WjSWmiHK/FPBtSMgt3HPJ7KBmwik'
const MAX_CONCURRENT_LOGIN_REQUESTS = 8

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name)
  private activeLoginRequests = 0

  constructor(
    private readonly repository: AuthRepository,
    private readonly passwordHasher: PasswordHasher,
    private readonly accessTokens: AccessTokenService,
    private readonly config: AuthConfig,
  ) {}

  async login(input: unknown, ipAddress: string | null) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new UnauthorizedException('Invalid credentials')
    const dto = input as Record<string, unknown>
    if (Object.keys(dto).some((key) => !['email','password'].includes(key)) ||
        typeof dto.email !== 'string' || dto.email.length > 320 ||
        typeof dto.password !== 'string' || Buffer.byteLength(dto.password) > 1024) {
      throw new UnauthorizedException('Invalid credentials')
    }
    return this.withLoginCapacity(() => this.loginValidated(dto.email as string, dto.password as string, ipAddress))
  }

  private async loginValidated(emailInput: string, password: string, ipAddress: string | null) {
    const email = normalizeEmail(emailInput)
    const emailHash = this.hashIdentifier(`email:${email}`)
    const ipHash = ipAddress ? this.hashIdentifier(`ip:${ipAddress}`) : null
    const rateKey = ipHash || this.hashIdentifier('ip:unknown')
    const rate = await this.repository.checkLoginRate(emailHash, rateKey)
    if (rate.blocked) throw new HttpException({ message: 'Too many sign-in attempts. Try again later.', retryAfterSeconds: rate.retryAfterSeconds }, HttpStatus.TOO_MANY_REQUESTS)

    const user = await this.repository.findUserByEmail(email)
    const verified = await this.passwordHasher.verify(user?.passwordHash || DUMMY_HASH, password)
    if (!user || !user.active || !verified) {
      await this.repository.recordLoginFailure(emailHash, rateKey)
      await this.repository.recordAudit('login_failure', user?.id || null, ipHash, { reason: 'invalid_credentials' })
      throw new UnauthorizedException('Invalid email or password')
    }

    await this.repository.clearLoginFailures(emailHash, rateKey)
    const session = await this.repository.createSession(user, ipHash)
    return { accessToken: this.accessTokens.issue(user, session.sessionId), user: publicUser(user), session }
  }

  private async withLoginCapacity<T>(operation: () => Promise<T>): Promise<T> {
    if (this.activeLoginRequests >= MAX_CONCURRENT_LOGIN_REQUESTS) {
      throw new HttpException('Login capacity is busy. Retry shortly.', HttpStatus.TOO_MANY_REQUESTS)
    }
    this.activeLoginRequests += 1
    try { return await operation() }
    finally { this.activeLoginRequests -= 1 }
  }

  async refresh(refreshToken: string | undefined, ipAddress: string | null) {
    const ipHash = ipAddress ? this.hashIdentifier(`ip:${ipAddress}`) : this.hashIdentifier('ip:unknown')
    const rate = await this.repository.checkRefreshRate(ipHash)
    if (rate.blocked) throw new HttpException({ message: 'Too many session refresh attempts.', retryAfterSeconds: rate.retryAfterSeconds }, HttpStatus.TOO_MANY_REQUESTS)
    await this.repository.recordRefreshAttempt(ipHash)
    if (!refreshToken || !/^[A-Za-z0-9_-]{43}$/.test(refreshToken)) throw new UnauthorizedException('Session expired. Sign in again.')
    const nextToken = randomBytes(32).toString('base64url')
    const result = await this.repository.rotateRefreshToken(createHash('sha256').update(refreshToken).digest(), nextToken, ipHash)
    if (result.status === 'reused') {
      this.logger.warn('Refresh token reuse detected; session revoked')
      throw new UnauthorizedException('Session expired. Sign in again.')
    }
    if (result.status !== 'rotated' || !result.user || !result.sessionId) throw new UnauthorizedException('Session expired. Sign in again.')
    return {
      accessToken: this.accessTokens.issue(result.user, result.sessionId),
      user: publicUser(result.user),
      refreshToken: result.refreshToken!,
      session: { sessionId: result.sessionId, absoluteExpiresAt: result.absoluteExpiresAt!, idleExpiresAt: result.idleExpiresAt! },
    }
  }

  async authenticateAccessToken(token: string): Promise<AuthPrincipal> {
    let principal: AuthPrincipal
    try { principal = this.accessTokens.verify(token) }
    catch { throw new UnauthorizedException('Authentication required') }
    const user = await this.repository.userForAccess(principal.userId, principal.sessionId, principal.sessionVersion)
    if (!user?.active) throw new UnauthorizedException('Authentication required')
    return { ...principal, email: user.email, name: user.name, role: user.role }
  }

  async authenticateRefreshCredential(token: string | undefined): Promise<AuthPrincipal | null> {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null
    const active = await this.repository.userForRefreshToken(createHash('sha256').update(token).digest())
    if (!active || !active.user.active) return null
    return { userId: active.user.id, email: active.user.email, name: active.user.name, role: active.user.role,
      sessionId: active.sessionId, sessionVersion: active.user.sessionVersion }
  }

  async logout(principal: AuthPrincipal, ipAddress: string | null): Promise<void> {
    await this.repository.revokeSession(principal.sessionId, principal.userId,
      ipAddress ? this.hashIdentifier(`ip:${ipAddress}`) : null, 'logout')
  }

  async logoutAll(principal: AuthPrincipal, ipAddress: string | null): Promise<void> {
    await this.repository.revokeAll(principal.userId, ipAddress ? this.hashIdentifier(`ip:${ipAddress}`) : null)
  }

  async bootstrapAdministrator(email: string, password: string, name: string): Promise<void> {
    validatePassword(password)
    await this.repository.createAdministrator(normalizeEmail(email), await this.passwordHasher.hash(password), name.trim())
  }

  async recoverAdministratorPassword(email: string, password: string): Promise<boolean> {
    validatePassword(password)
    return this.repository.recoverPassword(normalizeEmail(email), await this.passwordHasher.hash(password))
  }

  get accessLifetimeSeconds(): number { return this.config.value.accessLifetimeSeconds }

  private hashIdentifier(value: string): Buffer {
    const secret = this.config.value.signingKeys[this.config.value.activeKeyId]
    return createHmac('sha256', secret).update(value).digest()
  }
}

export function normalizeEmail(email: string): string { return email.trim().normalize('NFKC').toLowerCase() }
export function publicUser(user: AuthUser) { return { id: user.id, email: user.email, name: user.name, role: user.role } }
export function sameSecret(left: string, right: string): boolean {
  const a = createHash('sha256').update(left).digest(); const b = createHash('sha256').update(right).digest()
  return timingSafeEqual(a,b)
}
