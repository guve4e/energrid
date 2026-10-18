import { createHash, timingSafeEqual } from 'node:crypto'
import { UnauthorizedException } from '@nestjs/common'

export function isValidVoiceToken(token: unknown): token is string {
  if (typeof token !== 'string' || token.length === 0) return false

  const expected =
    process.env.PORTAL_CONTROL_TOKEN ||
    (process.env.NODE_ENV === 'production' ? '' : 'dev-token-admin')
  if (!expected) return false

  const providedHash = createHash('sha256').update(token).digest()
  const expectedHash = createHash('sha256').update(expected).digest()
  return timingSafeEqual(providedHash, expectedHash)
}

export function assertVoiceAuthorization(request: {
  headers: { authorization?: string | string[] }
}): void {
  const authorization = request.headers.authorization
  const value = Array.isArray(authorization) ? authorization[0] : authorization
  if (!value?.startsWith('Bearer ') || !isValidVoiceToken(value.slice(7))) {
    throw new UnauthorizedException('Voice access requires portal authorization.')
  }
}
