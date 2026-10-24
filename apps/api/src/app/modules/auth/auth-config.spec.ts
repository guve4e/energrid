import { AuthConfig } from './auth-config'

describe('AuthConfig', () => {
  const original = process.env
  afterEach(() => { process.env = original })

  it('fails closed in production when signing material or trusted origins are missing', () => {
    process.env = { NODE_ENV: 'production' }
    expect(() => new AuthConfig()).toThrow('Authentication requires')
    process.env = { NODE_ENV: 'production', AUTH_JWT_KEYS_JSON: JSON.stringify({ active: 'a-signing-key-longer-than-thirty-two-bytes' }),
      AUTH_JWT_ACTIVE_KID: 'active', AUTH_JWT_ISSUER: 'https://api.example.test', AUTH_JWT_AUDIENCE: 'https://portal.example.test' }
    expect(() => new AuthConfig()).toThrow('AUTH_TRUSTED_ORIGINS')
  })

  it('accepts explicit production HTTPS and loopback Portal origins, but rejects non-loopback HTTP', () => {
    process.env = { NODE_ENV: 'production', AUTH_JWT_KEYS_JSON: JSON.stringify({ active: 'a-signing-key-longer-than-thirty-two-bytes' }),
      AUTH_JWT_ACTIVE_KID: 'active', AUTH_JWT_ISSUER: 'https://api.example.test', AUTH_JWT_AUDIENCE: 'https://portal.example.test',
      AUTH_TRUSTED_ORIGINS: 'https://portal.example.test,http://localhost:4300' }
    expect(new AuthConfig().value.trustedOrigins.size).toBe(2)
    process.env.AUTH_TRUSTED_ORIGINS = 'http://remote.example.test'
    expect(() => new AuthConfig()).toThrow('exact HTTPS origins')
  })

  it('allows at most three explicit signing keys during rotation', () => {
    process.env = { NODE_ENV: 'test', AUTH_JWT_KEYS_JSON: JSON.stringify({ one: 'a-signing-key-longer-than-thirty-two-bytes', two: 'b-signing-key-longer-than-thirty-two-bytes', three: 'c-signing-key-longer-than-thirty-two-bytes', four: 'd-signing-key-longer-than-thirty-two-bytes' }),
      AUTH_JWT_ACTIVE_KID: 'one' }
    expect(() => new AuthConfig()).toThrow('at most three')
  })
})
