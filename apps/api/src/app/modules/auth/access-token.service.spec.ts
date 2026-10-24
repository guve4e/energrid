import jwt from 'jsonwebtoken'
import { AuthConfig } from './auth-config'
import { AccessTokenService } from './access-token.service'
import type { AuthUser } from './auth.types'

describe('AccessTokenService', () => {
  const original = process.env
  const account: AuthUser = { id: 'user-1', email: 'admin@example.test', name: 'Admin', role: 'admin', active: true,
    sessionVersion: 7, passwordHash: 'not-in-token' }
  let service: AccessTokenService

  beforeEach(() => {
    process.env = { NODE_ENV: 'test', AUTH_JWT_ACTIVE_KID: 'test-key', AUTH_JWT_KEYS_JSON: JSON.stringify({ 'test-key': 'a-signing-key-longer-than-thirty-two-bytes' }),
      AUTH_JWT_ISSUER: 'energrid-tests', AUTH_JWT_AUDIENCE: 'energrid-portal-tests' }
    service = new AccessTokenService(new AuthConfig())
  })
  afterAll(() => { process.env = original })

  it('issues a minimal fifteen-minute access token and validates the strict claims', () => {
    const token = service.issue(account, 'session-1')
    const principal = service.verify(token)
    expect(principal).toMatchObject({ userId: 'user-1', sessionId: 'session-1', sessionVersion: 7, role: 'admin' })
    const payload = jwt.decode(token) as Record<string, unknown>
    expect(payload).not.toHaveProperty('email')
    expect(payload).not.toHaveProperty('passwordHash')
    expect(payload).not.toHaveProperty('private')
    expect(payload.exp as number - payload.iat as number).toBe(900)
  })

  it('rejects expired, wrong-audience, tampered, and disallowed-algorithm tokens', () => {
    const key = process.env.AUTH_JWT_KEYS_JSON!
    const secret = JSON.parse(key)['test-key']
    expect(() => service.verify(jwt.sign({ sid: 's', ver: 0, role: 'admin', token_use: 'access' }, secret,
      { algorithm: 'HS256', subject: 'u', jwtid: 'j', issuer: 'energrid-tests', audience: 'energrid-portal-tests', expiresIn: -1 }))).toThrow()
    expect(() => service.verify(jwt.sign({ sid: 's', ver: 0, role: 'admin', token_use: 'access' }, secret,
      { algorithm: 'HS256', subject: 'u', jwtid: 'j', issuer: 'energrid-tests', audience: 'other', expiresIn: 60 }))).toThrow()
    const valid = service.issue(account, 'session-1')
    const [header, payload, signature] = valid.split('.')
    expect(() => service.verify(`${header}.${payload}.${signature.slice(0, -1)}x`)).toThrow()
    const hs384 = jwt.sign({ sid: 's', ver: 0, role: 'admin', token_use: 'access' }, secret,
      { algorithm: 'HS384', subject: 'u', jwtid: 'j', issuer: 'energrid-tests', audience: 'energrid-portal-tests', expiresIn: 60 })
    expect(() => service.verify(hs384)).toThrow()
  })
})
