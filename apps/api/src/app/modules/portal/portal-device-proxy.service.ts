import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { type RawData, WebSocket, WebSocketServer } from 'ws'
import { DeviceLanDiscoveryService } from '../devices/device-lan-discovery.service'
import type { NetworkDiscoveredDevice } from '../devices/device-registry.types'

export interface DeviceProxyRequest {
  method: string
  headers: Record<string, string | string[] | undefined>
  url: string
}

export interface DeviceProxyResponse {
  status(statusCode: number): DeviceProxyResponse
  setHeader(name: string, value: string): void
  send(body: string | Buffer): void
  end(): void
}

const hopByHopHeaders = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

const blockedResponseHeaders = new Set([
  'content-encoding',
  'content-length',
  'content-security-policy',
  'x-frame-options',
])

@Injectable()
export class PortalDeviceProxyService {
  private readonly logger = new Logger(PortalDeviceProxyService.name)
  private readonly upgradeServer = new WebSocketServer({ noServer: true })

  constructor(private readonly lanDiscovery: DeviceLanDiscoveryService) {}

  async proxy(
    deviceId: string,
    path: string,
    request: DeviceProxyRequest,
    response: DeviceProxyResponse,
  ): Promise<void> {
    const device = this.resolveDevice(deviceId)
    const method = request.method.toUpperCase()

    if (!isProxyMethodAllowed(method)) {
      throw new HttpException(
        'Device proxy write methods are disabled. Set PORTAL_DEVICE_PROXY_WRITE_ENABLED=true for installer mode.',
        HttpStatus.METHOD_NOT_ALLOWED,
      )
    }

    const targetUrl = buildTargetUrl(device.ipAddress, path, request.url)
    this.logger.log(`[DEVICE PROXY] ${method} ${device.ipAddress}${targetUrl.pathname}`)

    const controller = new AbortController()
    const timeout = setTimeout(
      () => controller.abort(),
      Number(process.env.PORTAL_DEVICE_PROXY_TIMEOUT_MS || 8000),
    )

    try {
      const upstream = await fetch(targetUrl, {
        method,
        headers: proxyRequestHeaders(request, device.ipAddress),
        body: ['GET', 'HEAD'].includes(method) ? undefined : request as unknown as BodyInit,
        duplex: ['GET', 'HEAD'].includes(method) ? undefined : 'half',
        redirect: 'manual',
        signal: controller.signal,
      } as RequestInit & { duplex?: 'half' })

      response.status(upstream.status)
      copyResponseHeaders(upstream, response, deviceId)

      const contentType = upstream.headers.get('content-type') || ''
      if (contentType.includes('text/html')) {
        const html = await upstream.text()
        response.send(rewriteHtml(html, deviceId, targetUrl.pathname))
        return
      }

      if (!upstream.body) {
        response.end()
        return
      }

      const body = Buffer.from(await upstream.arrayBuffer())
      response.send(body)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error'
      this.logger.warn(`[DEVICE PROXY] ${device.ipAddress} failed: ${message}`)
      throw new HttpException('Local device did not respond through the site gateway.', HttpStatus.BAD_GATEWAY)
    } finally {
      clearTimeout(timeout)
    }
  }

  handleWebSocketUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const parsed = parseProxyUrl(request.url || '')
    if (!parsed) return false

    let device: NetworkDiscoveredDevice
    try {
      device = this.resolveDevice(parsed.deviceId)
    } catch {
      socket.destroy()
      return true
    }

    const targetUrl = `ws://${device.ipAddress}${parsed.path}${parsed.search}`
    this.logger.log(`[DEVICE PROXY WS] ${device.ipAddress}${parsed.path}`)

    this.upgradeServer.handleUpgrade(request, socket, head, (client) => {
      bridgeWebSocket(client, targetUrl, this.logger)
    })

    return true
  }

  private resolveDevice(deviceId: string): NetworkDiscoveredDevice {
    const decodedDeviceId = decodeURIComponent(deviceId)
    const device = this.lanDiscovery.getLastScan().find((item) =>
      item.id === decodedDeviceId || item.ipAddress === decodedDeviceId,
    )

    if (!device) {
      throw new HttpException('Device is not in the latest local discovery scan.', HttpStatus.NOT_FOUND)
    }

    if (!isPrivateLanIp(device.ipAddress)) {
      throw new HttpException('Device proxy only allows private LAN addresses.', HttpStatus.FORBIDDEN)
    }

    return device
  }
}

function isProxyMethodAllowed(method: string): boolean {
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return true
  return process.env.PORTAL_DEVICE_PROXY_WRITE_ENABLED === 'true'
}

function buildTargetUrl(ipAddress: string, path: string, requestUrl: string): URL {
  const targetPath = normalizeProxyPath(path)
  const query = requestUrl.includes('?') ? requestUrl.slice(requestUrl.indexOf('?')) : ''
  return new URL(`http://${ipAddress}${targetPath}${query}`)
}

function normalizeProxyPath(path: string): string {
  const value = decodeURIComponent(path || '')
  if (!value || value === '/') return '/'
  const trimmed = value.replace(/^\/+/, '')
  return `/${trimmed}`
}

function proxyRequestHeaders(request: DeviceProxyRequest, ipAddress: string): Headers {
  const headers = new Headers()

  for (const [name, value] of Object.entries(request.headers)) {
    const lower = name.toLowerCase()
    if (hopByHopHeaders.has(lower) || lower === 'host') continue
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item)
    } else if (value != null) {
      headers.set(name, String(value))
    }
  }

  headers.set('host', ipAddress)
  headers.set('x-energrid-device-proxy', 'true')

  return headers
}

function copyResponseHeaders(
  upstream: globalThis.Response,
  response: DeviceProxyResponse,
  deviceId: string,
): void {
  upstream.headers.forEach((value, name) => {
    const lower = name.toLowerCase()
    if (hopByHopHeaders.has(lower) || blockedResponseHeaders.has(lower)) return
    response.setHeader(name, value)
  })

  response.setHeader('x-energrid-device-proxy', deviceId)
}

function rewriteHtml(html: string, deviceId: string, currentPath: string): string {
  const base = `/portal/device-proxy/${encodeURIComponent(deviceId)}${parentPath(currentPath)}`
  return html.replace(
    /<head([^>]*)>/i,
    `<head$1><base href="${base}"><script>${deviceProxyBrowserPatch(deviceId)}</script>`,
  )
}

function parentPath(path: string): string {
  if (!path || path === '/') return '/'
  const parts = path.split('/')
  parts.pop()
  const value = parts.join('/')
  return `${value || ''}/`
}

function isPrivateLanIp(ipAddress: string): boolean {
  if (/^10\./.test(ipAddress)) return true
  if (/^192\.168\./.test(ipAddress)) return true
  return /^172\.(1[6-9]|2\d|3[0-1])\./.test(ipAddress)
}

function parseProxyUrl(url: string): { deviceId: string; path: string; search: string } | null {
  const parsed = new URL(url, 'http://energrid.local')
  const match = parsed.pathname.match(/^\/portal\/device-proxy\/([^/]+)(\/.*)?$/)
  if (!match) return null

  return {
    deviceId: decodeURIComponent(match[1]),
    path: match[2] || '/',
    search: parsed.search,
  }
}

function bridgeWebSocket(client: WebSocket, targetUrl: string, logger: Logger): void {
  const upstream = new WebSocket(targetUrl)
  const pending: Array<{ data: RawData; isBinary: boolean }> = []

  client.on('message', (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(data, { binary: isBinary })
      return
    }

    pending.push({ data, isBinary })
  })

  upstream.on('open', () => {
    for (const item of pending.splice(0)) upstream.send(item.data, { binary: item.isBinary })
  })

  upstream.on('message', (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary })
  })

  upstream.on('close', (code, reason) => {
    if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
      closeWebSocket(client, code, reason)
    }
  })

  client.on('close', (code, reason) => {
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
      closeWebSocket(upstream, code, reason)
    }
  })

  upstream.on('error', (error) => {
    logger.warn(`[DEVICE PROXY WS] upstream failed: ${error.message}`)
    if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
      client.close(1011, 'upstream unavailable')
    }
  })

  client.on('error', () => {
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
      upstream.close()
    }
  })
}

function closeWebSocket(socket: WebSocket, code: number, reason: Buffer): void {
  if (isValidCloseCode(code)) {
    socket.close(code, reason)
    return
  }

  socket.close()
}

function isValidCloseCode(code: number): boolean {
  if (code >= 1000 && code <= 1014) return ![1004, 1005, 1006].includes(code)
  return code >= 3000 && code <= 4999
}

function deviceProxyBrowserPatch(deviceId: string): string {
  return `
(() => {
  const deviceId = ${JSON.stringify(deviceId)};
  const proxyPath = (path) => '/portal/device-proxy/' + encodeURIComponent(deviceId) + path;
  const rewriteHttp = (input) => {
    try {
      const value = String(input);
      const url = new URL(value, location.href);
      if (url.pathname === '/rpc' || url.pathname.startsWith('/rpc/')) {
        return proxyPath(url.pathname + url.search + url.hash);
      }
      return input;
    } catch {
      return input;
    }
  };
  const rewriteWs = (input) => {
    const next = rewriteHttp(input);
    if (next === input) return input;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return protocol + '//' + location.host + next;
  };

  const NativeWebSocket = window.WebSocket;
  window.WebSocket = function EnergridDeviceProxyWebSocket(url, protocols) {
    const next = rewriteWs(url);
    return protocols === undefined ? new NativeWebSocket(next) : new NativeWebSocket(next, protocols);
  };
  window.WebSocket.prototype = NativeWebSocket.prototype;
  Object.defineProperty(window.WebSocket, 'OPEN', { value: NativeWebSocket.OPEN });
  Object.defineProperty(window.WebSocket, 'CONNECTING', { value: NativeWebSocket.CONNECTING });
  Object.defineProperty(window.WebSocket, 'CLOSING', { value: NativeWebSocket.CLOSING });
  Object.defineProperty(window.WebSocket, 'CLOSED', { value: NativeWebSocket.CLOSED });

  const nativeFetch = window.fetch?.bind(window);
  if (nativeFetch) {
    window.fetch = (input, init) => nativeFetch(typeof input === 'string' ? rewriteHttp(input) : input, init);
  }

  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    return nativeOpen.call(this, method, rewriteHttp(url), ...rest);
  };
})();
`.trim()
}
