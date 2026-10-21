import { randomUUID } from 'node:crypto';
import type { NetworkDiscoveredDevice, NetworkDiscoveryZone } from '../devices/device-registry.types';
import { ipInCidr } from '../devices/device-lan-discovery.service';
import { isNetworkObservationFresh, networkObservationFreshnessMs } from '../devices/network-observation-freshness';

const maxRefreshAuthorizations = 128;

export interface NeighborIdentityObservation {
  reachable: boolean;
  macAddress?: string;
  interfaceName?: string;
}

export type EndpointIdentityRefreshResult =
  | { outcome: 'verified'; reasonCode: 'historical_mac_matched'; refreshId: string; action: 'http_head_root'; source: 'direct_arp_reply'; method: 'single_target_nmap_arp_ping'; scopeId: string; ipAddress: string; historicalMac: string; observedMac: string; observedAt: string; interfaceName?: string }
  | { outcome: 'changed'; reasonCode: 'identity_changed'; source: 'direct_arp_reply'; method: 'single_target_nmap_arp_ping'; scopeId: string; ipAddress: string; historicalMac: string; observedMac: string; observedAt: string; interfaceName?: string }
  | { outcome: 'failed'; reasonCode: 'historical_identity_not_established' | 'endpoint_not_reachable' | 'mac_evidence_unavailable' | 'identity_refresh_unavailable' }
  | { outcome: 'rejected'; reasonCode: 'operator_approval_required' | 'network_target_out_of_scope' | 'conflicting_identity_evidence' };

type PendingRefresh = {
  target: NetworkDiscoveredDevice;
  action: 'http_head_root';
  source: 'direct_arp_reply';
  method: 'single_target_nmap_arp_ping';
  observedMac: string;
  observedAt: string;
  interfaceName?: string;
  expiresAt: number;
};

export class NetworkEndpointIdentityRefresh {
  private readonly pending = new Map<string, PendingRefresh>();

  constructor(
    private readonly observe: (ipAddress: string) => Promise<NeighborIdentityObservation>,
    private readonly now: () => number = Date.now,
  ) {}

  async refresh(
    target: NetworkDiscoveredDevice,
    zones: readonly NetworkDiscoveryZone[],
    operatorApproved: boolean,
  ): Promise<EndpointIdentityRefreshResult> {
    if (!operatorApproved) return { outcome: 'rejected', reasonCode: 'operator_approval_required' };
    if (target.identityConflict) return { outcome: 'rejected', reasonCode: 'conflicting_identity_evidence' };
    const zone = zones.find(item => item.id === target.networkZoneId);
    if (!zone || !isPrivateIpv4(target.ipAddress) || !isUnicastTargetInZone(target.ipAddress, zone)) {
      return { outcome: 'rejected', reasonCode: 'network_target_out_of_scope' };
    }

    const historicalMac = normalizeUnicastMac(target.macAddress);
    if (!historicalMac) return { outcome: 'failed', reasonCode: 'historical_identity_not_established' };

    let observation: NeighborIdentityObservation;
    try {
      observation = await this.observe(target.ipAddress);
    } catch {
      return { outcome: 'failed', reasonCode: 'identity_refresh_unavailable' };
    }
    if (!observation || typeof observation !== 'object') {
      return { outcome: 'failed', reasonCode: 'identity_refresh_unavailable' };
    }
    const observedAt = new Date(this.now()).toISOString();
    if (!observation.reachable) return { outcome: 'failed', reasonCode: 'endpoint_not_reachable' };
    const observedMac = normalizeUnicastMac(observation.macAddress);
    if (!observedMac) return { outcome: 'failed', reasonCode: 'mac_evidence_unavailable' };

    const shared = {
      source: 'direct_arp_reply' as const,
      method: 'single_target_nmap_arp_ping' as const,
      scopeId: target.networkZoneId,
      ipAddress: target.ipAddress,
      historicalMac,
      observedMac,
      observedAt,
      ...(observation.interfaceName ? { interfaceName: observation.interfaceName } : {}),
    };
    if (historicalMac !== observedMac) return { outcome: 'changed', reasonCode: 'identity_changed', ...shared };

    this.expirePending();
    const refreshId = randomUUID();
    this.pending.set(refreshId, {
      target: structuredClone(target),
      action: 'http_head_root',
      source: shared.source,
      method: shared.method,
      observedMac,
      observedAt,
      ...(observation.interfaceName ? { interfaceName: observation.interfaceName } : {}),
      expiresAt: this.now() + networkObservationFreshnessMs,
    });
    while (this.pending.size > maxRefreshAuthorizations) {
      const oldest = this.pending.keys().next().value;
      if (!oldest) break;
      this.pending.delete(oldest);
    }
    return { outcome: 'verified', reasonCode: 'historical_mac_matched', refreshId, action: 'http_head_root', ...shared };
  }

  consumeVerifiedRefresh(
    refreshId: string,
    target: NetworkDiscoveredDevice,
    zones: readonly NetworkDiscoveryZone[],
  ): NetworkDiscoveredDevice | null {
    this.expirePending();
    const refresh = this.pending.get(refreshId);
    if (!refresh) return null;
    // Consume synchronously before validation so simultaneous requests cannot
    // both spend the same authorization. The token is also action-bound.
    this.pending.delete(refreshId);
    const sameTarget = refresh.target.id === target.id &&
      refresh.target.ipAddress === target.ipAddress &&
      refresh.target.networkZoneId === target.networkZoneId &&
      refresh.target.macAddress?.toLowerCase() === target.macAddress?.toLowerCase();
    if (refresh.action !== 'http_head_root' || refresh.source !== 'direct_arp_reply' ||
      refresh.method !== 'single_target_nmap_arp_ping' || !sameTarget ||
      !isNetworkObservationFresh(refresh.observedAt, this.now())) return null;
    const zone = zones.find(item => item.id === target.networkZoneId);
    if (!zone || !isUnicastTargetInZone(target.ipAddress, zone)) return null;
    return {
      ...target,
      macAddress: refresh.observedMac,
      status: 'online',
      discoveredAt: refresh.observedAt,
      reason: `A fresh single-target ARP reply on ${refresh.interfaceName || 'the local interface'} matched the saved MAC; authorized only for the fixed HTTP HEAD / check.`,
    };
  }

  private expirePending(): void {
    const now = this.now();
    for (const [id, refresh] of this.pending) {
      if (refresh.expiresAt < now) this.pending.delete(id);
    }
  }
}

function normalizeUnicastMac(value?: string): string | null {
  if (!value || !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(value.trim())) return null;
  const mac = value.trim().toLowerCase();
  const firstOctet = Number.parseInt(mac.slice(0, 2), 16);
  if ((firstOctet & 1) !== 0 || mac === '00:00:00:00:00:00') return null;
  return mac;
}

function isPrivateIpv4(value: string): boolean {
  const octets = value.split('.').map(Number);
  if (octets.length !== 4 || octets.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = octets;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function isUnicastTargetInZone(ipAddress: string, zone: NetworkDiscoveryZone): boolean {
  if (!zone.cidr) return zone.seedIps.includes(ipAddress) && ipAddress !== '255.255.255.255';
  if (!ipInCidr(ipAddress, zone.cidr)) return false;
  const [network, prefixText] = zone.cidr.split('/');
  const prefix = Number(prefixText);
  if (prefix >= 31) return true;
  const ipNumber = ipv4Number(ipAddress);
  const networkNumber = network ? ipv4Number(network) : null;
  if (ipNumber === null || networkNumber === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 30) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const first = (networkNumber & mask) >>> 0;
  const last = (first | (~mask >>> 0)) >>> 0;
  return ipNumber > first && ipNumber < last;
}

function ipv4Number(value: string): number | null {
  const octets = value.split('.');
  if (octets.length !== 4 || octets.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
  return octets.reduce((result, part) => ((result << 8) | Number(part)) >>> 0, 0);
}
