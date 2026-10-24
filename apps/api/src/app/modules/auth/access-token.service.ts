import { Injectable } from '@nestjs/common'
import jwt, { type JwtPayload } from 'jsonwebtoken'
import { randomUUID } from 'node:crypto'
import { AuthConfig } from './auth-config'
import type { AuthPrincipal, AuthUser } from './auth.types'

@Injectable()
export class AccessTokenService {
  constructor(private readonly config: AuthConfig) {}

  issue(user: AuthUser, sessionId: string): string {
    const c = this.config.value
    return jwt.sign({ sid: sessionId, role: user.role, ver: user.sessionVersion, token_use: 'access' }, c.signingKeys[c.activeKeyId], {
      algorithm: 'HS256', keyid: c.activeKeyId,
      subject: user.id, jwtid: randomUUID(), issuer: c.issuer, audience: c.audience,
      expiresIn: c.accessLifetimeSeconds,
    })
  }

  verify(token: string): AuthPrincipal {
    const c = this.config.value
    let payload: JwtPayload | undefined
    for (const [kid, secret] of Object.entries(c.signingKeys)) {
      try {
        const verified = jwt.verify(token, secret, { algorithms: ['HS256'], issuer: c.issuer, audience: c.audience, complete: true })
        if (!verified || typeof verified === 'string' || verified.header.alg !== 'HS256' || verified.header.kid !== kid || verified.header.typ !== 'JWT') continue
        payload = verified.payload as JwtPayload
        break
      } catch { /* Try the next explicitly configured rotation key. */ }
    }
    if (!payload || typeof payload.sub !== 'string' || typeof payload.sid !== 'string' ||
        typeof payload.jti !== 'string' || !Number.isSafeInteger(payload.ver) ||
        !['admin','installer','viewer'].includes(String(payload.role)) || payload.token_use !== 'access' ||
        typeof payload.iat !== 'number' || typeof payload.exp !== 'number') {
      throw new Error('invalid_access_token')
    }
    return { userId: payload.sub, email: '', name: '', role: payload.role as AuthPrincipal['role'], sessionId: payload.sid, sessionVersion: payload.ver as number }
  }
}
