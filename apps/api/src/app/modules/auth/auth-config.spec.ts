import { AuthConfig, macLabLanOrigins } from './auth-config'

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

  it('adds exact active Mac LAB LAN origins only for the isolated local auth database', () => {
    const env = { NODE_ENV: 'development', AUTH_DATABASE_URL: 'postgres://dev@127.0.0.1:5432/energrid_auth_local',
      AUTH_JWT_ACTIVE_KID: 'local', AUTH_JWT_ISSUER: 'energrid-local' }
    const interfaces = { en0: [
      { address: '192.168.7.24', netmask: '255.255.255.0', family: 'IPv4', mac: '', internal: false, cidr: '192.168.7.24/24' },
      { address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '', internal: true, cidr: '127.0.0.1/8' },
    ] }
    expect(macLabLanOrigins(env, interfaces)).toEqual(['http://192.168.7.24:4300'])
    expect(macLabLanOrigins({ ...env, NODE_ENV: 'production' }, interfaces)).toEqual([])
    expect(macLabLanOrigins({ ...env, AUTH_DATABASE_URL: 'postgres://prod@db.example.test:5432/energrid' }, interfaces)).toEqual([])
    expect(macLabLanOrigins({ ...env, AUTH_JWT_ACTIVE_KID: 'production-key' }, interfaces)).toEqual([])
  })

  it('allows at most three explicit signing keys during rotation', () => {
    process.env = { NODE_ENV: 'test', AUTH_JWT_KEYS_JSON: JSON.stringify({ one: 'a-signing-key-longer-than-thirty-two-bytes', two: 'b-signing-key-longer-than-thirty-two-bytes', three: 'c-signing-key-longer-than-thirty-two-bytes', four: 'd-signing-key-longer-than-thirty-two-bytes' }),
      AUTH_JWT_ACTIVE_KID: 'one' }
    expect(() => new AuthConfig()).toThrow('at most three')
  })
})
