import { Injectable } from '@nestjs/common'
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'

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
    for (const origin of macLabLanOrigins(environment, networkInterfaces())) trustedOrigins.add(origin)
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


/** Exact private-LAN origins for the isolated Mac LAB portal. This is deliberately
 * tied to the loopback-only local auth database and local signing key; it cannot
 * enable LAN origins in production or on a production database. */
export function macLabLanOrigins(
  environment: NodeJS.ProcessEnv,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): string[] {
  if (environment.NODE_ENV === 'production' || environment.AUTH_JWT_ACTIVE_KID !== 'local' ||
      environment.AUTH_JWT_ISSUER !== 'energrid-local') return []
  let database: URL
  try { database = new URL(environment.AUTH_DATABASE_URL || '') } catch { return [] }
  if (!['127.0.0.1', '[::1]'].includes(database.hostname) || database.port !== '5432' ||
      database.pathname !== '/energrid_auth_local') return []
  const addresses = new Set<string>()
  for (const entries of Object.values(interfaces)) for (const entry of entries || []) {
    if (entry.internal || entry.family !== 'IPv4' || !isPrivateLanIpv4(entry.address)) continue
    addresses.add(entry.address)
  }
  return [...addresses].map(address => `http://${address}:4300`)
}

function isPrivateLanIpv4(address: string): boolean {
  const octets = address.split('.').map(Number)
  if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return false
  return octets[0] === 10 || octets[0] === 192 && octets[1] === 168 ||
    octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31
}
