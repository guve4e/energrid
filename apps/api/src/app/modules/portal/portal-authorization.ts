import { UnauthorizedException } from '@nestjs/common';
import type { DeviceProxyRequest } from './portal-device-proxy.service';

/** Defensive runtime check in addition to the controller-level JWT and role guards. */
export function assertPortalAdministrator(request: DeviceProxyRequest): void {
  if (request.user?.role !== 'admin') {
    throw new UnauthorizedException('Device control requires portal authorization.');
  }
}
