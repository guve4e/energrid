import { Injectable } from '@nestjs/common';
import { request as httpRequest } from 'node:http';
import type { NetworkDiscoveredDevice, NetworkDiscoveryZone } from '../devices/device-registry.types';
import { ipInCidr } from '../devices/device-lan-discovery.service';
import { isNetworkObservationFresh } from '../devices/network-observation-freshness';

export interface HttpHeadResponse {
  statusCode: number;
  headers: { server?: string; contentType?: string };
}

export interface HttpHeadTransport {
  request(ipAddress: string, port: 80, timeoutMs: number, maxHeaderBytes: number): Promise<HttpHeadResponse>;
}

export type HttpIdentityProbeResult =
  | { outcome: 'completed'; reasonCode: 'http_response_received'; ipAddress: string; statusCode: number; server?: string; contentType?: string; observedAt: string }
  | { outcome: 'rejected'; reasonCode: 'operator_approval_required' | 'network_target_not_current' | 'network_target_out_of_scope' | 'network_target_not_private' | 'conflicting_mac_evidence' | 'probe_rate_limited' | 'probe_capacity_reached' }
  | { outcome: 'failed'; reasonCode: 'http_probe_timeout_or_transport_error' };

const probeIntervalMs = 5_000;
const maxConcurrentProbes = 2;

@Injectable()
export class ReadOnlyHttpIdentityProbe {
  private readonly active = new Set<string>();
  private readonly lastStartedAt = new Map<string, number>();

  constructor(
    private readonly transport: HttpHeadTransport = new NodeHttpHeadTransport(),
    private readonly now: () => number = Date.now,
  ) {}

  async run(
    target: NetworkDiscoveredDevice,
    zones: readonly NetworkDiscoveryZone[],
    operatorApproved: boolean,
  ): Promise<HttpIdentityProbeResult> {
    if (!operatorApproved) return { outcome: 'rejected', reasonCode: 'operator_approval_required' };
    if (target.status !== 'online' || !target.id || !target.networkZoneId || !target.ipAddress ||
      !isNetworkObservationFresh(target.discoveredAt, this.now())) {
      return { outcome: 'rejected', reasonCode: 'network_target_not_current' };
    }
    if (target.identityConflict?.macAddresses.length) {
      return { outcome: 'rejected', reasonCode: 'conflicting_mac_evidence' };
    }
    if (!isPrivateIpv4(target.ipAddress)) {
      return { outcome: 'rejected', reasonCode: 'network_target_not_private' };
    }
    const zone = zones.find(item => item.id === target.networkZoneId);
    const inZone = !!zone && (zone.seedIps.includes(target.ipAddress) ||
      (!!zone.cidr && ipInCidr(target.ipAddress, zone.cidr)));
    if (!inZone) return { outcome: 'rejected', reasonCode: 'network_target_out_of_scope' };

    const key = `${target.networkZoneId}:${target.ipAddress}`;
    const startedAt = this.now();
    if (this.active.has(key) || (this.lastStartedAt.has(key) && startedAt - this.lastStartedAt.get(key)! < probeIntervalMs)) {
      return { outcome: 'rejected', reasonCode: 'probe_rate_limited' };
    }
    if (this.active.size >= maxConcurrentProbes) {
      return { outcome: 'rejected', reasonCode: 'probe_capacity_reached' };
    }

    this.active.add(key);
    this.lastStartedAt.set(key, startedAt);
    if (this.lastStartedAt.size > 1024) {
      const oldest = this.lastStartedAt.keys().next().value;
      if (oldest) this.lastStartedAt.delete(oldest);
    }
    try {
      const response = await this.transport.request(target.ipAddress, 80, 2500, 4096);
      return {
        outcome: 'completed',
        reasonCode: 'http_response_received',
        ipAddress: target.ipAddress,
        statusCode: response.statusCode,
        ...(safeServerHeader(response.headers.server) ? { server: safeServerHeader(response.headers.server) } : {}),
        ...(safeContentType(response.headers.contentType) ? { contentType: safeContentType(response.headers.contentType) } : {}),
        observedAt: new Date(this.now()).toISOString(),
      };
    } catch {
      return { outcome: 'failed', reasonCode: 'http_probe_timeout_or_transport_error' };
    } finally {
      this.active.delete(key);
    }
  }
}

class NodeHttpHeadTransport implements HttpHeadTransport {
  request(ipAddress: string, port: 80, timeoutMs: number, maxHeaderBytes: number): Promise<HttpHeadResponse> {
    return new Promise((resolve, reject) => {
      const request = httpRequest({
        hostname: ipAddress,
        port,
        method: 'HEAD',
        path: '/',
        timeout: timeoutMs,
        maxHeaderSize: maxHeaderBytes,
        agent: false,
      }, response => {
        resolve({
          statusCode: response.statusCode || 0,
          headers: {
            server: safeServerHeader(headerValue(response.headers.server)),
            contentType: safeContentType(headerValue(response.headers['content-type'])),
          },
        });
        // HEAD responses are not expected to have a body. Stop reading even
        // if a nonconforming host sends one; diagnostics never capture payloads.
        response.destroy();
      });
      request.once('timeout', () => request.destroy(new Error('timeout')));
      request.once('error', reject);
      request.end();
    });
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function safeServerHeader(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/[\r\n\0-\x1f\x7f]/g, ' ').trim().slice(0, 120);
  if (/authorization|bearer|token|password|secret|api[_-]?key/i.test(normalized)) return undefined;
  return normalized || undefined;
}

function safeContentType(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const mediaType = value.split(';', 1)[0].trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mediaType)
    ? mediaType.slice(0, 100)
    : undefined;
}

function isPrivateIpv4(value: string): boolean {
  const parts = value.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 169 && b === 254);
}
