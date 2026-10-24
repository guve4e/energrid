export type AccountRole = 'admin' | 'installer' | 'viewer'

export interface AuthUser {
  id: string
  email: string
  name: string
  role: AccountRole
  active: boolean
  sessionVersion: number
  passwordHash: string
}

export interface AuthPrincipal {
  userId: string
  email: string
  name: string
  role: AccountRole
  sessionId: string
  sessionVersion: number
}

export interface AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>
  cookies?: Record<string, string | undefined>
  user?: AuthPrincipal
  originalUrl?: string
  method?: string
}

export const AUTH_POOL = Symbol('AUTH_POOL')
export const AUTH_TRUSTED_ORIGINS = Symbol('AUTH_TRUSTED_ORIGINS')
