import { GoneException, Injectable } from '@nestjs/common'
import type { AuthPrincipal } from '../auth/auth.types'

export interface DeviceProxyRequest {
  method: string
  headers: Record<string, string | string[] | undefined>
  url: string
  user?: AuthPrincipal
}

export interface DeviceProxyResponse {
  status(statusCode: number): DeviceProxyResponse
  setHeader(name: string, value: string): void
  send(body: string | Buffer): void
  end(): void
}

/**
 * Vendor device pages are not proxied. Their HTTP methods and URL semantics
 * are not a reliable indication of whether a request changes physical state.
 */
@Injectable()
export class PortalDeviceProxyService {
  proxy(
    _deviceId: string,
    _path: string,
    _request: DeviceProxyRequest,
    _response: DeviceProxyResponse,
  ): never {
    throw new GoneException(
      'Device web pages are no longer proxied. Use the authorized device workflow in Energrid.',
    )
  }
}
