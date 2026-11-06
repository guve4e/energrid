import type { RegisteredDevice } from '../devices/device-registry.types';
import type { NetworkDiscoverySnapshot } from '../devices/network-discovery-snapshot';
import { SITE_LOCAL_SHELLY_EVIDENCE_MAX_AGE_MS, type AuthorizedSiteLocalObserver } from '../devices/site-local-shelly-evidence-intake';
import type { PhysicalDeviceInventoryRecord } from '../devices/enrollment/physical-device-inventory.repository';
import { findExactShellyInventoryAssignment } from './site-local-shelly-inventory-match';

export interface ShellyEndpointRecoveryProposal {
  deviceId: string;
  displayName: string;
  physicalId: string;
  component: string;
  physicalInventoryId: string;
  endpoint: string;
  scopeId: string;
  scopeCidr: string;
  identityObservedAt: string | null;
  componentObservedAt: string | null;
  evidenceFresh: boolean;
  currentEndpoint: string | null;
  currentScope: string | null;
  observerStatus: 'authorized' | 'missing' | 'ambiguous' | 'invalid';
  observerId: string | null;
  conflictEndpoints: string[];
  status: 'verification_required' | 'observer_required' | 'observer_configuration_invalid' | 'conflict' | 'already_current' | 'inventory_conflict' | 'inventory_unavailable';
}

/** Read-only projection from a site-owned scan to exact enrolled Shelly assignments.
 * It proposes addresses only; the site-local RPC report and existing reconciliation
 * writer remain the only path that can update an installation route. */
export function projectShellyEndpointRecoveryProposals(input: {
  snapshot: NetworkDiscoverySnapshot;
  owner: { tenantId: string; siteId: string };
  devices: readonly RegisteredDevice[];
  inventories: readonly PhysicalDeviceInventoryRecord[];
  observers: readonly AuthorizedSiteLocalObserver[] | null;
  inventoryAvailable?: boolean;
  now?: number;
}): ShellyEndpointRecoveryProposal[] {
  const { snapshot, owner } = input;
  if (snapshot.schemaVersion < 2 || snapshot.ownership?.tenantId !== owner.tenantId || snapshot.ownership.siteId !== owner.siteId) return [];

  const candidates = snapshot.endpoints.flatMap(endpoint => {
    const identityAt = endpoint.observations?.find(item =>
      (item.source === 'http_rpc' && item.attribute === 'shelly.device_id' && item.value === endpoint.id) ||
      (item.source === 'http_identity' && item.attribute === 'identity.device_id' && item.value === endpoint.id &&
        endpoint.observations?.some(verified => verified.source === 'http_identity' &&
          verified.attribute === 'identity.verified' && verified.value === true && verified.observedAt === item.observedAt)),
    )?.observedAt || null;
    if (endpoint.vendor !== 'Shelly' || !identityAt || endpoint.id.toLowerCase() !== endpoint.id.trim().toLowerCase()) return [];

    return (endpoint.components || []).flatMap(({ component }) => {
      if (!/^(?:switch|em1):(?:[0-9]|[12][0-9]|3[01])$/.test(component)) return [];
      const deviceId = `${endpoint.id}:${component}`;
      const device = input.devices.find(item => item.id.toLowerCase() === deviceId.toLowerCase() &&
        item.tenantId === owner.tenantId && item.siteId === owner.siteId &&
        item.trustStatus === 'approved' && item.kind === 'physical');
      if (!device) return [];
      const inventory = findExactShellyInventoryAssignment(
        input.inventories, owner, device.id, endpoint.id, component,
      );
      const componentMethod = `${component.startsWith('switch:') ? 'Switch' : 'EM1'}.GetStatus?id=${component.split(':')[1]}`;
      const componentAt = endpoint.observations?.find(item =>
        ['http_rpc', 'site_local_http_rpc'].includes(item.source) && item.attribute === 'shelly.component_status' &&
        item.value === component && item.method === componentMethod && item.scopeId === endpoint.networkZoneId,
      )?.observedAt || null;
      const scope = snapshot.scopes.find(item => item.id === endpoint.networkZoneId);
      const matchingObservers = (input.observers || []).filter(observer => observer.tenantId === owner.tenantId &&
        observer.siteId === owner.siteId && observer.scopeId === endpoint.networkZoneId &&
        observer.cidr === scope?.cidr &&
        (!observer.expectedDeviceIds || observer.expectedDeviceIds.some(id => id.toLowerCase() === endpoint.id.toLowerCase())) &&
        (!observer.expectedComponentKeys || observer.expectedComponentKeys.includes(component)));
      const scannedEndpoints = snapshot.endpoints.filter(other => other.vendor === 'Shelly' &&
        other.id.toLowerCase() === endpoint.id.toLowerCase() &&
        other.observations?.some(item => (item.source === 'http_rpc' && item.attribute === 'shelly.device_id' && item.value === endpoint.id) ||
          (item.source === 'http_identity' && item.attribute === 'identity.device_id' && item.value === endpoint.id &&
            other.observations?.some(verified => verified.source === 'http_identity' && verified.attribute === 'identity.verified' &&
              verified.value === true && verified.observedAt === item.observedAt))));
      const inventoryEndpoints = (inventory?.networkObservations || []).filter(item => item.isCurrent).map(item =>
        `${scopeMatchesProposal(item.networkScope, endpoint.networkZoneId, scope?.cidr || '') ? endpoint.networkZoneId : item.networkScope}:${item.ipAddress}`,
      );
      const conflictEndpoints = [...new Set([
        ...scannedEndpoints.map(item => `${item.networkZoneId}:${item.ipAddress}`),
        ...inventoryEndpoints,
      ])].sort();
      const now = input.now ?? Date.now();
      const evidenceFresh = [identityAt, componentAt].every(value => {
        const time = value ? Date.parse(value) : Number.NaN;
        return Number.isFinite(time) && time <= now && now - time <= SITE_LOCAL_SHELLY_EVIDENCE_MAX_AGE_MS;
      });
      const currentEndpoint = typeof device.metadata?.ipAddress === 'string' ? device.metadata.ipAddress : null;
      const currentScope = typeof device.metadata?.networkScope === 'string' ? device.metadata.networkScope : null;
      const observerStatus: ShellyEndpointRecoveryProposal['observerStatus'] = matchingObservers.length === 1
        ? 'authorized' : matchingObservers.length > 1 ? 'ambiguous' : input.observers === null ? 'invalid' : 'missing';
      const status: ShellyEndpointRecoveryProposal['status'] = input.inventoryAvailable === false ? 'inventory_unavailable'
        : !inventory ? 'inventory_conflict'
        : conflictEndpoints.length > 1 ? 'conflict'
        : currentEndpoint === endpoint.ipAddress && scopeMatchesProposal(currentScope, endpoint.networkZoneId, scope?.cidr || '')
          ? 'already_current'
        : input.observers === null ? 'observer_configuration_invalid'
        : matchingObservers.length === 0 ? 'observer_required'
        : matchingObservers.length > 1 ? 'conflict'
        : 'verification_required';
      return [{
        deviceId: device.id, displayName: device.displayName, physicalId: endpoint.id, component,
        physicalInventoryId: inventory?.physicalDeviceId || String(device.metadata?.physicalInventoryId || ''),
        endpoint: endpoint.ipAddress, scopeId: endpoint.networkZoneId, scopeCidr: scope?.cidr || '',
        identityObservedAt: identityAt, componentObservedAt: componentAt, evidenceFresh,
        currentEndpoint, currentScope,
        observerStatus,
        observerId: matchingObservers.length === 1 ? matchingObservers[0].id : null,
        conflictEndpoints,
        status,
      }];
    });
  });
  return candidates;
}

function scopeMatchesProposal(savedScope: string | null, scopeId: string, cidr: string): boolean {
  return savedScope === scopeId || savedScope?.endsWith(`:${scopeId}`) === true ||
    (!!cidr && (savedScope === `${scopeId}:${cidr}` || savedScope?.endsWith(`:${scopeId}:${cidr}`) === true));
}
