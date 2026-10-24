import type { AuthPrincipal } from '../auth/auth.types'
import type { AuthService } from '../auth/auth.service'

export async function authenticateVoiceToken(auth: AuthService, token: unknown): Promise<AuthPrincipal | null> {
  if (typeof token !== 'string' || token.length > 8192) return null
  try {
    const principal = await auth.authenticateAccessToken(token)
    return principal.role === 'admin' ? principal : null
  } catch { return null }
}
