import { AuthConfig } from './auth-config'
import { AccessTokenService } from './access-token.service'
import { AuthRepository } from './auth.repository'
import { PasswordHasher } from './password-hasher'
import { AuthService } from './auth.service'
import type { AuthUser } from './auth.types'

describe('AuthService', () => {
  const original = process.env
  let repository: jest.Mocked<AuthRepository>
  let passwords: PasswordHasher
  let service: AuthService

  const user = (patch: Partial<AuthUser> = {}): AuthUser => ({
    id: 'user-id', email: 'admin@example.test', name: 'Admin', role: 'admin', active: true,
    sessionVersion: 0, passwordHash: '$argon2id$v=19$m=19456,p=1,t=2$UstYPSv3p29B8S0vXlgMuw$Yg+O5fjajK23AH8WjSWmiHK/FPBtSMgt3HPJ7KBmwik',
    ...patch,
  })

  beforeEach(() => {
    process.env = { ...original, NODE_ENV: 'test', AUTH_JWT_ACTIVE_KID: 'test', AUTH_JWT_KEYS_JSON: JSON.stringify({ test: 'test-signing-secret-at-least-32-bytes-long' }), AUTH_TRUSTED_ORIGINS: 'http://localhost:4300' }
    repository = {
      findUserByEmail: jest.fn(), checkLoginRate: jest.fn().mockResolvedValue({ blocked: false, retryAfterSeconds: 0 }),
      recordLoginFailure: jest.fn(), recordAudit: jest.fn(), clearLoginFailures: jest.fn(), createSession: jest.fn(),
      checkRefreshRate: jest.fn().mockResolvedValue({ blocked: false, retryAfterSeconds: 0 }), recordRefreshAttempt: jest.fn(),
      rotateRefreshToken: jest.fn(), userForAccess: jest.fn(), revokeSession: jest.fn(), revokeAll: jest.fn(),
      bootstrapAdministrator: jest.fn(), recoverAdministratorPassword: jest.fn(), createAdministrator: jest.fn(), recoverPassword: jest.fn(),
    } as unknown as jest.Mocked<AuthRepository>
    passwords = new PasswordHasher()
    const config = new AuthConfig()
    service = new AuthService(repository, passwords, new AccessTokenService(config), config)
  })

  afterAll(() => { process.env = original })

  it('authenticates an active account and returns a short-lived access JWT without a JSON refresh token', async () => {
    repository.findUserByEmail.mockResolvedValue(user())
    repository.createSession.mockResolvedValue({ sessionId: 'session-id', refreshToken: 'r'.repeat(43), absoluteExpiresAt: new Date(Date.now()+30*86400_000), idleExpiresAt: new Date(Date.now()+7*86400_000) })
    const result = await service.login({ email: ' ADMIN@EXAMPLE.TEST ', password: 'energrid-invalid-account-dummy' }, '127.0.0.1')
    expect(result.accessToken).toMatch(/^eyJ/)
    expect(result).not.toHaveProperty('refreshToken')
    expect(repository.clearLoginFailures).toHaveBeenCalled()
    expect(repository.createSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'user-id' }), expect.any(Buffer))
  })

  it('uses a generic rejection for unknown users, disabled users, bad passwords and malformed hashes', async () => {
    repository.findUserByEmail.mockResolvedValue(null)
    await expect(service.login({ email: 'unknown@example.test', password: 'wrong-password' }, '127.0.0.1')).rejects.toThrow('Invalid email or password')
    repository.findUserByEmail.mockResolvedValue(user({ active: false }))
    await expect(service.login({ email: 'admin@example.test', password: 'energrid-invalid-account-dummy' }, '127.0.0.1')).rejects.toThrow('Invalid email or password')
    repository.findUserByEmail.mockResolvedValue(user({ passwordHash: 'malformed' }))
    await expect(service.login({ email: 'admin@example.test', password: 'energrid-invalid-account-dummy' }, '127.0.0.1')).rejects.toThrow('Invalid email or password')
    expect(repository.recordLoginFailure).toHaveBeenCalledTimes(3)
  })

  it('rejects extra fields and rate-limited login attempts before password verification', async () => {
    await expect(service.login({ email: 'admin@example.test', password: 'long-enough-password', role: 'admin' }, '127.0.0.1')).rejects.toThrow('Invalid credentials')
    repository.checkLoginRate.mockResolvedValue({ blocked: true, retryAfterSeconds: 90 })
    await expect(service.login({ email: 'admin@example.test', password: 'long-enough-password' }, '127.0.0.1')).rejects.toMatchObject({ status: 429 })
    expect(repository.findUserByEmail).not.toHaveBeenCalled()
  })

  it('rejects excess concurrent login work before it can queue unbounded database and hash requests', async () => {
    const releaseChecks: Array<(decision: { blocked: boolean; retryAfterSeconds: number }) => void> = []
    repository.checkLoginRate.mockImplementation(() => new Promise(resolve => releaseChecks.push(resolve)))
    const input = { email: 'admin@example.test', password: 'long-enough-password' }
    const active = Array.from({ length: 8 }, () => service.login(input, '127.0.0.1'))

    await expect(service.login(input, '127.0.0.1')).rejects.toMatchObject({ status: 429 })
    expect(releaseChecks).toHaveLength(8)

    releaseChecks.forEach(release => release({ blocked: true, retryAfterSeconds: 60 }))
    await Promise.allSettled(active)
    expect(repository.findUserByEmail).not.toHaveBeenCalled()
  })

  it('revokes access immediately when the session or account version is no longer current', async () => {
    repository.findUserByEmail.mockResolvedValue(user())
    repository.createSession.mockResolvedValue({ sessionId: 'session-id', refreshToken: 'r'.repeat(43), absoluteExpiresAt: new Date(Date.now()+30*86400_000), idleExpiresAt: new Date(Date.now()+7*86400_000) })
    const login = await service.login({ email: 'admin@example.test', password: 'energrid-invalid-account-dummy' }, '127.0.0.1')
    repository.userForAccess.mockResolvedValue(null)
    const access = (service as unknown as { accessTokens: AccessTokenService }).accessTokens
    const token = access.issue(user(), 'session-id')
    await expect(service.authenticateAccessToken(token)).rejects.toThrow('Authentication required')
    expect(login.accessToken).toBeTruthy()
  })

  it('detects refresh replay through the persisted token family result', async () => {
    repository.rotateRefreshToken.mockResolvedValue({ status: 'reused', sessionId: 'session-id' })
    await expect(service.refresh('r'.repeat(43), '127.0.0.1')).rejects.toThrow('Session expired')
    expect(repository.recordRefreshAttempt).toHaveBeenCalledWith(expect.any(Buffer))
  })

  it('uses Argon2id password hashes and rejects invalid or malformed hashes safely', async () => {
    const hash = await passwords.hash('a-long-password-for-testing')
    expect(hash.startsWith('$argon2id$')).toBe(true)
    await expect(passwords.verify(hash, 'a-long-password-for-testing')).resolves.toBe(true)
    await expect(passwords.verify(hash, 'wrong-password')).resolves.toBe(false)
    await expect(passwords.verify('not-a-hash', 'wrong-password')).resolves.toBe(false)
  })
})
