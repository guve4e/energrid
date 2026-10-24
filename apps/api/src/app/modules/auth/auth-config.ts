import { Injectable } from '@nestjs/common'

export interface AuthConfiguration {
  production: boolean
  issuer: string
  audience: string
  activeKeyId: string
  signingKeys: Record<string, string>
  trustedOrigins: Set<string>
  accessLifetimeSeconds: number
}

@Injectable()
export class AuthConfig {
  readonly value: AuthConfiguration

  constructor() {
    const environment = process.env
    const production = environment.NODE_ENV === 'production'
    const issuer = environment.AUTH_JWT_ISSUER?.trim() || (!production ? 'energrid-local' : '')
    const audience = environment.AUTH_JWT_AUDIENCE?.trim() || (!production ? 'energrid-portal' : '')
    const rawKeys = environment.AUTH_JWT_KEYS_JSON?.trim()
    let signingKeys: Record<string, string> = {}
    if (rawKeys) {
      try {
        const parsed: unknown = JSON.parse(rawKeys)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          signingKeys = Object.fromEntries(Object.entries(parsed).filter(
            ([kid, key]) => /^[A-Za-z0-9_-]{1,40}$/.test(kid) && typeof key === 'string' && Buffer.byteLength(key) >= 32,
          )) as Record<string, string>
        }
      } catch {
        throw new Error('AUTH_JWT_KEYS_JSON must be a JSON object of signing key IDs to 32+ byte secrets')
      }
    }
    const activeKeyId = environment.AUTH_JWT_ACTIVE_KID?.trim() || ''
    if (!production && !rawKeys) {
      const localKey = environment.AUTH_JWT_LOCAL_SECRET?.trim() || ''
      if (Buffer.byteLength(localKey) >= 32) {
        signingKeys = { local: localKey }
      }
    }
    if (!issuer || !audience || !activeKeyId || !signingKeys[activeKeyId]) {
      throw new Error('Authentication requires AUTH_JWT_ISSUER, AUTH_JWT_AUDIENCE, AUTH_JWT_ACTIVE_KID, and a configured 32+ byte AUTH_JWT_KEYS_JSON key')
    }
    if (Object.keys(signingKeys).length > 3) throw new Error('Configure at most three JWT verification keys during bounded key rotation')
    if (!production && activeKeyId === 'local' && !environment.AUTH_JWT_ACTIVE_KID) {
      // The local key ID is deliberately explicit in generated development config.
      throw new Error('Set AUTH_JWT_ACTIVE_KID=local in local development configuration')
    }
    const trustedOrigins = parseOrigins(environment.AUTH_TRUSTED_ORIGINS, production)
    this.value = { production, issuer, audience, activeKeyId, signingKeys, trustedOrigins, accessLifetimeSeconds: 900 }
  }
}

function parseOrigins(value: string | undefined, production: boolean): Set<string> {
  const origins = (value || '').split(',').map((origin) => origin.trim()).filter(Boolean)
  if (!origins.length && !production) {
    origins.push('http://localhost:4300', 'http://127.0.0.1:4300')
  }
  const parsed = origins.map((origin) => {
    let url: URL
    try { url = new URL(origin) } catch { throw new Error('AUTH_TRUSTED_ORIGINS must contain exact origins') }
    const isExplicitLoopbackHttp = !production ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    if (url.origin !== origin || url.username || url.password || (production && url.protocol !== 'https:' && !isExplicitLoopbackHttp)) {
      throw new Error('AUTH_TRUSTED_ORIGINS must contain exact HTTPS origins in production (explicit loopback HTTP is allowed for portal:pi development)')
    }
    return origin
  })
  if (production && !parsed.length) throw new Error('AUTH_TRUSTED_ORIGINS is required in production')
  return new Set(parsed)
}

