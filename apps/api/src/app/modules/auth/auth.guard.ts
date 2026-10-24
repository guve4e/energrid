import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata, UnauthorizedException } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { AuthService } from './auth.service'
import type { AccountRole, AuthenticatedRequest } from './auth.types'

const PUBLIC_ROUTE = 'energrid.auth.public'
const REQUIRED_ROLES = 'energrid.auth.roles'
export const PublicRoute = () => SetMetadata(PUBLIC_ROUTE, true)
export const RequireRoles = (...roles: AccountRole[]) => SetMetadata(REQUIRED_ROLES, roles)

@Injectable()
export class AccessJwtGuard implements CanActivate {
  constructor(private readonly auth: AuthService, private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [context.getHandler(), context.getClass()])
    if (isPublic) return true
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>()
    const header = request.headers.authorization
    const value = Array.isArray(header) ? header[0] : header
    if (!value?.startsWith('Bearer ') || value.length > 8192) throw new UnauthorizedException('Authentication required')
    request.user = await this.auth.authenticateAccessToken(value.slice(7))
    return true
  }
}

@Injectable()
export class RoleGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [context.getHandler(), context.getClass()])
    if (isPublic) return true
    const required = this.reflector.getAllAndOverride<AccountRole[]>(REQUIRED_ROLES, [context.getHandler(), context.getClass()]) || []
    if (!required.length) return true
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>()
    if (!request.user) throw new UnauthorizedException('Authentication required')
    if (!required.includes(request.user.role)) throw new ForbiddenException('Insufficient permissions')
    return true
  }
}

export function requirePrincipal(request: AuthenticatedRequest) {
  if (!request.user) throw new UnauthorizedException('Authentication required')
  return request.user
}
