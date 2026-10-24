import { ForbiddenException, UnauthorizedException } from '@nestjs/common'
import type { ExecutionContext } from '@nestjs/common'
import type { Reflector } from '@nestjs/core'
import { AccessJwtGuard, RoleGuard } from './auth.guard'
import type { AuthService } from './auth.service'

function context(request: Record<string, unknown>): ExecutionContext {
  return {
    getHandler: () => ({}), getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext
}

describe('Portal authorization guards', () => {
  it('rejects requests without an access bearer token', async () => {
    const reflector = { getAllAndOverride: () => false } as unknown as Reflector
    const guard = new AccessJwtGuard({} as AuthService, reflector)
    await expect(guard.canActivate(context({ headers: {} }))).rejects.toBeInstanceOf(UnauthorizedException)
  })

  it('hydrates the principal from current server authorization, then enforces role policy', async () => {
    const principal = { userId: 'u1', email: 'viewer@example.test', name: 'Viewer', role: 'viewer' as const, sessionId: 's1', sessionVersion: 1 }
    const auth = { authenticateAccessToken: jest.fn().mockResolvedValue(principal) } as unknown as AuthService
    const reflector = { getAllAndOverride: (key: string) => key === 'energrid.auth.roles' ? ['admin'] : false } as unknown as Reflector
    const request = { headers: { authorization: 'Bearer short-jwt' } }
    const access = new AccessJwtGuard(auth, reflector)
    expect(await access.canActivate(context(request))).toBe(true)
    expect(request).toHaveProperty('user', principal)
    const roles = new RoleGuard(reflector)
    expect(() => roles.canActivate(context(request))).toThrow(ForbiddenException)
  })
})
