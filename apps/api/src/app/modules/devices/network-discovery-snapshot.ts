import type { NetworkDiscoveredDevice, NetworkDiscoveryZone } from './device-registry.types';
import type { LocalNetworkRuntimeReport } from './adapters/outbound/network/local-network-runtime.adapter';

export interface NetworkDiscoverySnapshot {
  schemaVersion: 1 | 2;
  scanId: string;
  /** Ownership is absent only on snapshots created before site scoping was added. */
  ownership?: { tenantId: string; siteId: string };
  /** Read-only API projection; never persisted as scan evidence. */
  ownershipStatus?: 'scoped' | 'legacy-unscoped';
  startedAt: string;
  completedAt: string;
  collector: { id: string; host: string; interfaces: string[] };
  scopes: Array<{
    id: string;
    name: string;
    cidr?: string;
    interfaceName?: string;
    role?: NetworkDiscoveryZone['role'];
    collectionSource?: NetworkDiscoveryZone['collectionSource'];
    complete: boolean;
    gatewayIpsObserved: string[];
    collectionStages?: {
      hostDiscovery: { durationMs: number; complete: boolean; targetCount: number; hostsReported: number; failure?: string };
      serviceEnrichment: { durationMs: number; complete: boolean; targetCount: number; hostsReported: number; failure?: string };
    };
  }>;
  methods: string[];
  successes: number;
  failures: string[];
  limitations: string[];
  rawEvidenceOmitted: number;
  rawEvidence: Array<{
    observedAt: string;
    source: string;
    scopeId: string;
    evidence: Record<string, unknown>;
  }>;
  endpoints: NetworkDiscoveredDevice[];
  topology: { relationships: Array<{
    from: string;
    to: string;
    relation: 'routed' | 'bridged' | 'wired' | 'wifi' | 'unknown';
    verification: 'verified' | 'inferred' | 'unknown';
    evidence: string[];
  }> };
  runtime?: LocalNetworkRuntimeReport;
}

export interface NetworkDiscoverySnapshotDiff {
  fromScanId: string;
  toScanId: string;
  comparableScopes: string[];
  incompleteScopes: string[];
  addedEndpoints: Array<{ scopeId: string; ipAddress: string; macAddress?: string }>;
  notDetectedEndpoints: Array<{ scopeId: string; ipAddress: string; macAddress?: string }>;
  verifiedAddressChanges: Array<{ scopeId: string; identity: string; from: string; to: string }>;
  ipReuse: Array<{ scopeId: string; ipAddress: string; previousIdentity?: string; currentIdentity?: string; previousObservedMac?: string; currentObservedMac?: string }>;
  serviceChanges: Array<{ scopeId: string; ipAddress: string; added: string[]; removed: string[] }>;
  scopeChanges: Array<{ scopeId: string; previousCidr?: string; currentCidr?: string; previousInterface?: string; currentInterface?: string }>;
  macChanges: Array<{
    scopeId: string;
    identity: string;
    previousObservedMac?: string;
    currentObservedMac?: string;
    previousDeviceReportedMac?: string;
    currentDeviceReportedMac?: string;
  }>;
  hostnameChanges: Array<{ scopeId: string; identity: string; previous: string; current: string }>;
  gatewayChanges: Array<{ scopeId: string; previous: string[]; current: string[] }>;
  identityChanges: Array<{ scopeId: string; ipAddress: string; previous: string; current: string }>;
  topologyChanges: { added: NetworkDiscoverySnapshot['topology']['relationships']; removed: NetworkDiscoverySnapshot['topology']['relationships'] };
}

export function compareNetworkSnapshots(
  previous: NetworkDiscoverySnapshot,
  current: NetworkDiscoverySnapshot,
): NetworkDiscoverySnapshotDiff {
  const ownershipMatches = !!previous.ownership && !!current.ownership &&
    previous.ownership.tenantId === current.ownership.tenantId &&
    previous.ownership.siteId === current.ownership.siteId;
  const previousScopes = new Map(previous.scopes.map(scope => [scope.id, scope]));
  const currentScopes = new Map(current.scopes.map(scope => [scope.id, scope]));
  const comparableScopes = (ownershipMatches ? current.scopes : [])
    .filter(scope => {
      const previousScope = previousScopes.get(scope.id);
      return !!previousScope && previousScope.cidr === scope.cidr &&
        previousScope.interfaceName === scope.interfaceName &&
        previousScope.complete === scope.complete &&
        sameStageCoverage(previousScope, scope) &&
        sameMethods(previous.methods, current.methods);
    })
    .map(scope => scope.id)
    .sort();
  const incompleteScopes = comparableScopes
    .filter(scopeId => !currentScopes.get(scopeId)?.complete)
    .sort();
  const diff: NetworkDiscoverySnapshotDiff = {
    fromScanId: previous.scanId,
    toScanId: current.scanId,
    comparableScopes,
    incompleteScopes,
    addedEndpoints: [],
    notDetectedEndpoints: [],
    verifiedAddressChanges: [],
    ipReuse: [],
    serviceChanges: [],
    scopeChanges: [],
    macChanges: [],
    hostnameChanges: [],
    gatewayChanges: [],
    identityChanges: [],
    topologyChanges: { added: [], removed: [] },
  };

  if (!ownershipMatches) return diff;

  for (const currentScope of current.scopes) {
    const previousScope = previousScopes.get(currentScope.id);
    if (previousScope && (previousScope.cidr !== currentScope.cidr || previousScope.interfaceName !== currentScope.interfaceName)) {
      diff.scopeChanges.push({
        scopeId: currentScope.id,
        ...(previousScope.cidr ? { previousCidr: previousScope.cidr } : {}),
        ...(currentScope.cidr ? { currentCidr: currentScope.cidr } : {}),
        ...(previousScope.interfaceName ? { previousInterface: previousScope.interfaceName } : {}),
        ...(currentScope.interfaceName ? { currentInterface: currentScope.interfaceName } : {}),
      });
    }
    const previousGateways = [...(previousScope?.gatewayIpsObserved || [])].sort();
    const currentGateways = [...(currentScope.gatewayIpsObserved || [])].sort();
    if (previousScope && JSON.stringify(previousGateways) !== JSON.stringify(currentGateways)) {
      diff.gatewayChanges.push({
        scopeId: currentScope.id,
        previous: previousGateways,
        current: currentGateways,
      });
    }
  }

  for (const scopeId of comparableScopes) {
    const before = previous.endpoints.filter(device => device.networkZoneId === scopeId);
    const after = current.endpoints.filter(device => device.networkZoneId === scopeId);
    const beforeByIp = new Map(before.map(device => [device.ipAddress, device]));
    const afterByIp = new Map(after.map(device => [device.ipAddress, device]));
    const beforeByIdentity = verifiedIdentities(before);
    const afterByIdentity = verifiedIdentities(after);

    for (const device of after) {
      const previousAtIp = beforeByIp.get(device.ipAddress);
      if (!previousAtIp && !beforeByIdentity.has(verifiedIdentityValue(device) || '')) {
        diff.addedEndpoints.push(endpointSummary(scopeId, device));
      }
      if (previousAtIp && changedIdentity(previousAtIp, device)) {
        diff.ipReuse.push({
          scopeId,
          ipAddress: device.ipAddress,
          ...(verifiedIdentityValue(previousAtIp) ? { previousIdentity: previousAtIp.id } : {}),
          ...(verifiedIdentityValue(device) ? { currentIdentity: device.id } : {}),
          ...(previousAtIp.macAddress ? { previousObservedMac: previousAtIp.macAddress } : {}),
          ...(device.macAddress ? { currentObservedMac: device.macAddress } : {}),
        });
      }
      if (previousAtIp) {
        const previousIdentity = verifiedIdentityValue(previousAtIp);
        const currentIdentity = verifiedIdentityValue(device);
        if (previousIdentity && currentIdentity && previousIdentity !== currentIdentity) {
          diff.identityChanges.push({ scopeId, ipAddress: device.ipAddress, previous: previousIdentity, current: currentIdentity });
        }
        if (!verifiedIdentityValue(device) && !verifiedIdentityValue(previousAtIp)) {
          appendServiceChange(diff, scopeId, device, previousAtIp);
        }
      }
    }

    for (const [identity, beforeDevice] of beforeByIdentity) {
      const afterDevice = afterByIdentity.get(identity);
      if (afterDevice && beforeDevice.ipAddress !== afterDevice.ipAddress) {
        diff.verifiedAddressChanges.push({ scopeId, identity: beforeDevice.id.toLowerCase(), from: beforeDevice.ipAddress, to: afterDevice.ipAddress });
      }
      if (afterDevice) appendServiceChange(diff, scopeId, afterDevice, beforeDevice);
      if (afterDevice && (
        meaningfulMacChange(beforeDevice.deviceReportedMacAddress, afterDevice.deviceReportedMacAddress) ||
        meaningfulMacChange(beforeDevice.macAddress, afterDevice.macAddress)
      )) {
        diff.macChanges.push({ scopeId, identity,
          ...(beforeDevice.macAddress ? { previousObservedMac: beforeDevice.macAddress } : {}),
          ...(afterDevice.macAddress ? { currentObservedMac: afterDevice.macAddress } : {}),
          ...(beforeDevice.deviceReportedMacAddress ? { previousDeviceReportedMac: beforeDevice.deviceReportedMacAddress } : {}),
          ...(afterDevice.deviceReportedMacAddress ? { currentDeviceReportedMac: afterDevice.deviceReportedMacAddress } : {}),
        });
      }
      if (afterDevice && meaningfulHostnameChange(beforeDevice.hostname, afterDevice.hostname)) {
        diff.hostnameChanges.push({ scopeId, identity, previous: beforeDevice.hostname || '', current: afterDevice.hostname || '' });
      }
    }

    if (!incompleteScopes.includes(scopeId)) {
      for (const device of before) {
        const identity = verifiedIdentityValue(device);
        const verifiedDeviceMoved = !!identity && afterByIdentity.has(identity);
        if (!afterByIp.has(device.ipAddress) && !verifiedDeviceMoved) {
          diff.notDetectedEndpoints.push(endpointSummary(scopeId, device));
        }
      }
    }
  }

  diff.addedEndpoints.sort(endpointSort);
  diff.notDetectedEndpoints.sort(endpointSort);
  diff.verifiedAddressChanges.sort((a, b) => a.identity.localeCompare(b.identity));
  diff.ipReuse.sort((a, b) => a.scopeId.localeCompare(b.scopeId) || a.ipAddress.localeCompare(b.ipAddress));
  diff.serviceChanges.sort((a, b) => a.scopeId.localeCompare(b.scopeId) || a.ipAddress.localeCompare(b.ipAddress));
  diff.scopeChanges.sort((a, b) => a.scopeId.localeCompare(b.scopeId));
  diff.macChanges.sort((a, b) => a.identity.localeCompare(b.identity));
  diff.hostnameChanges.sort((a, b) => a.identity.localeCompare(b.identity));
  diff.gatewayChanges.sort((a, b) => a.scopeId.localeCompare(b.scopeId));
  diff.identityChanges.sort((a, b) => a.scopeId.localeCompare(b.scopeId) || a.ipAddress.localeCompare(b.ipAddress));
  const previousRelations = new Map(previous.topology.relationships.map(relation => [relationshipKey(relation), relation]));
  const currentRelations = new Map(current.topology.relationships.map(relation => [relationshipKey(relation), relation]));
  diff.topologyChanges = {
    added: [...currentRelations].filter(([key]) => !previousRelations.has(key)).map(([, relation]) => relation),
    removed: [...previousRelations].filter(([key]) => !currentRelations.has(key)).map(([, relation]) => relation),
  };
  return diff;
}

function verifiedIdentities(devices: NetworkDiscoveredDevice[]): Map<string, NetworkDiscoveredDevice> {
  const ordered = [...devices].filter(device => !!verifiedIdentityValue(device)).sort((a, b) =>
    b.discoveredAt.localeCompare(a.discoveredAt) || a.ipAddress.localeCompare(b.ipAddress),
  );
  return new Map(ordered.map(device => [verifiedIdentityValue(device)!, device]));
}

function verifiedIdentityValue(device: NetworkDiscoveredDevice): string | null {
  const shellyId = device.observations?.find(observation =>
    observation.source === 'http_rpc' && observation.attribute === 'shelly.device_id',
  )?.value;
  if (typeof shellyId === 'string' && shellyId && shellyId === device.id) return shellyId.toLowerCase();

  const identityVerified = device.observations?.some(observation =>
    observation.source === 'http_identity' && observation.attribute === 'identity.verified' && observation.value === true,
  );
  const reportedId = device.observations?.find(observation =>
    observation.source === 'http_identity' && observation.attribute === 'identity.device_id',
  )?.value;
  return identityVerified && typeof reportedId === 'string' && reportedId && reportedId.toLowerCase() === device.id.toLowerCase()
    ? reportedId.toLowerCase()
    : null;
}

function relationshipKey(relationship: NetworkDiscoverySnapshot['topology']['relationships'][number]): string {
  return JSON.stringify({ ...relationship, evidence: [...relationship.evidence].sort() });
}

function changedIdentity(previous: NetworkDiscoveredDevice, current: NetworkDiscoveredDevice): boolean {
  const previousIdentity = verifiedIdentityValue(previous);
  const currentIdentity = verifiedIdentityValue(current);
  if (previousIdentity && currentIdentity) return previousIdentity !== currentIdentity;
  return meaningfulMacChange(previous.macAddress, current.macAddress);
}

function normalizeMac(value: string): string {
  return value.toLowerCase().replace(/[.:-]/g, '').replace(/\s/g, '');
}

function meaningfulMacChange(previous?: string, current?: string): boolean {
  return !!previous && !!current && normalizeMac(previous) !== normalizeMac(current);
}

function meaningfulHostnameChange(previous?: string, current?: string): boolean {
  return !!previous?.trim() && !!current?.trim() &&
    previous.trim().toLocaleLowerCase() !== current.trim().toLocaleLowerCase();
}

function sameMethods(previous: string[], current: string[]): boolean {
  return [...previous].sort().join('\u0000') === [...current].sort().join('\u0000');
}

function sameStageCoverage(previous: NetworkDiscoverySnapshot['scopes'][number], current: NetworkDiscoverySnapshot['scopes'][number]): boolean {
  const before = previous.collectionStages;
  const after = current.collectionStages;
  if (!before || !after) return before === after;
  return before.hostDiscovery.complete === after.hostDiscovery.complete &&
    before.serviceEnrichment.complete === after.serviceEnrichment.complete;
}

function serviceEvidence(device: NetworkDiscoveredDevice): string[] {
  return [...new Set((device.observations || [])
    .filter(observation => observation.source === 'tcp' && observation.value === true && /\.open$/.test(observation.attribute))
    .map(observation => `${observation.attribute}=${observation.value}`))].sort();
}

function appendServiceChange(
  diff: NetworkDiscoverySnapshotDiff,
  scopeId: string,
  current: NetworkDiscoveredDevice,
  previous: NetworkDiscoveredDevice,
): void {
  const previousServices = serviceEvidence(previous);
  const currentServices = serviceEvidence(current);
  const added = currentServices.filter(value => !previousServices.includes(value));
  // A missing positive port observation is not evidence that a service was removed.
  if (added.length) diff.serviceChanges.push({ scopeId, ipAddress: current.ipAddress, added, removed: [] });
}

function endpointSummary(scopeId: string, device: NetworkDiscoveredDevice) {
  return { scopeId, ipAddress: device.ipAddress, ...(device.macAddress ? { macAddress: device.macAddress } : {}) };
}

function endpointSort(a: { scopeId: string; ipAddress: string }, b: { scopeId: string; ipAddress: string }): number {
  return a.scopeId.localeCompare(b.scopeId) || a.ipAddress.localeCompare(b.ipAddress);
}
