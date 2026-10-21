import type { NetworkDiscoveredDevice, NetworkDiscoveryZone } from './device-registry.types';

export interface NetworkDiscoverySnapshot {
  schemaVersion: 1;
  scanId: string;
  startedAt: string;
  completedAt: string;
  collector: { id: string; host: string; interfaces: string[] };
  scopes: Array<{
    id: string;
    name: string;
    cidr?: string;
    interfaceName?: string;
    role?: NetworkDiscoveryZone['role'];
    complete: boolean;
    gatewayIpsObserved: string[];
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
}

export interface NetworkDiscoverySnapshotDiff {
  fromScanId: string;
  toScanId: string;
  comparableScopes: string[];
  incompleteScopes: string[];
  addedEndpoints: Array<{ scopeId: string; ipAddress: string; macAddress?: string }>;
  notDetectedEndpoints: Array<{ scopeId: string; ipAddress: string; macAddress?: string }>;
  verifiedAddressChanges: Array<{ identity: string; from: string; to: string }>;
  ipReuse: Array<{ scopeId: string; ipAddress: string; previousIdentity?: string; currentIdentity?: string }>;
  serviceChanges: Array<{ scopeId: string; ipAddress: string; added: string[]; removed: string[] }>;
  scopeChanges: Array<{ scopeId: string; previousCidr?: string; currentCidr?: string; previousInterface?: string; currentInterface?: string }>;
  macChanges: Array<{
    identity: string;
    previousObservedMac?: string;
    currentObservedMac?: string;
    previousDeviceReportedMac?: string;
    currentDeviceReportedMac?: string;
  }>;
  gatewayChanges: Array<{ scopeId: string; previous: string[]; current: string[] }>;
  identityChanges: Array<{ scopeId: string; ipAddress: string; previous: string; current: string }>;
  topologyChanges: { added: NetworkDiscoverySnapshot['topology']['relationships']; removed: NetworkDiscoverySnapshot['topology']['relationships'] };
}

export function compareNetworkSnapshots(
  previous: NetworkDiscoverySnapshot,
  current: NetworkDiscoverySnapshot,
): NetworkDiscoverySnapshotDiff {
  const previousScopes = new Map(previous.scopes.map(scope => [scope.id, scope]));
  const currentScopes = new Map(current.scopes.map(scope => [scope.id, scope]));
  const comparableScopes = current.scopes
    .filter(scope => previousScopes.get(scope.id)?.cidr === scope.cidr)
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
    gatewayChanges: [],
    identityChanges: [],
    topologyChanges: { added: [], removed: [] },
  };

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
      if (!previousAtIp && !beforeByIdentity.has(device.id)) {
        diff.addedEndpoints.push(endpointSummary(scopeId, device));
      }
      if (previousAtIp && changedIdentity(previousAtIp, device)) {
        diff.ipReuse.push({
          scopeId,
          ipAddress: device.ipAddress,
          ...(verifiedShellyIdentity(previousAtIp) ? { previousIdentity: previousAtIp.id } : {}),
          ...(verifiedShellyIdentity(device) ? { currentIdentity: device.id } : {}),
        });
      }
      if (previousAtIp) {
        const previousVerification = identityVerification(previousAtIp);
        const currentVerification = identityVerification(device);
        if (previousVerification !== currentVerification) {
          diff.identityChanges.push({ scopeId, ipAddress: device.ipAddress, previous: previousVerification, current: currentVerification });
        }
        if (!verifiedShellyIdentity(device) && !verifiedShellyIdentity(previousAtIp)) {
          appendServiceChange(diff, scopeId, device, previousAtIp);
        }
      }
    }

    for (const [identity, beforeDevice] of beforeByIdentity) {
      const afterDevice = afterByIdentity.get(identity);
      if (afterDevice && beforeDevice.ipAddress !== afterDevice.ipAddress) {
        diff.verifiedAddressChanges.push({ identity, from: beforeDevice.ipAddress, to: afterDevice.ipAddress });
      }
      if (afterDevice) appendServiceChange(diff, scopeId, afterDevice, beforeDevice);
      if (afterDevice && (
        beforeDevice.deviceReportedMacAddress?.toLowerCase() !== afterDevice.deviceReportedMacAddress?.toLowerCase() ||
        beforeDevice.macAddress?.toLowerCase() !== afterDevice.macAddress?.toLowerCase()
      )) {
        diff.macChanges.push({ identity,
          ...(beforeDevice.macAddress ? { previousObservedMac: beforeDevice.macAddress } : {}),
          ...(afterDevice.macAddress ? { currentObservedMac: afterDevice.macAddress } : {}),
          ...(beforeDevice.deviceReportedMacAddress ? { previousDeviceReportedMac: beforeDevice.deviceReportedMacAddress } : {}),
          ...(afterDevice.deviceReportedMacAddress ? { currentDeviceReportedMac: afterDevice.deviceReportedMacAddress } : {}),
        });
      }
    }

    if (!incompleteScopes.includes(scopeId)) {
      for (const device of before) {
        if (!afterByIp.has(device.ipAddress)) {
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
  const ordered = [...devices].filter(verifiedShellyIdentity).sort((a, b) =>
    b.discoveredAt.localeCompare(a.discoveredAt) || a.ipAddress.localeCompare(b.ipAddress),
  );
  return new Map(ordered.map(device => [device.id, device]));
}

function verifiedShellyIdentity(device: NetworkDiscoveredDevice): boolean {
  return device.vendor === 'Shelly' && device.protocol === 'http' && /^shelly[a-z0-9._-]+$/i.test(device.id);
}

function identityVerification(device: NetworkDiscoveredDevice): string {
  return verifiedShellyIdentity(device) ? `verified:${device.id}` : 'not-established';
}

function relationshipKey(relationship: NetworkDiscoverySnapshot['topology']['relationships'][number]): string {
  return JSON.stringify({ ...relationship, evidence: [...relationship.evidence].sort() });
}

function changedIdentity(previous: NetworkDiscoveredDevice, current: NetworkDiscoveredDevice): boolean {
  if (verifiedShellyIdentity(previous) && verifiedShellyIdentity(current)) return previous.id !== current.id;
  const beforeMac = previous.macAddress?.toLowerCase();
  const afterMac = current.macAddress?.toLowerCase();
  return !!beforeMac && !!afterMac && beforeMac !== afterMac;
}

function serviceEvidence(device: NetworkDiscoveredDevice): string[] {
  return [...new Set((device.observations || [])
    .filter(observation => observation.source === 'tcp' && observation.value === true)
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
  const removed = previousServices.filter(value => !currentServices.includes(value));
  if (added.length || removed.length) diff.serviceChanges.push({ scopeId, ipAddress: current.ipAddress, added, removed });
}

function endpointSummary(scopeId: string, device: NetworkDiscoveredDevice) {
  return { scopeId, ipAddress: device.ipAddress, ...(device.macAddress ? { macAddress: device.macAddress } : {}) };
}

function endpointSort(a: { scopeId: string; ipAddress: string }, b: { scopeId: string; ipAddress: string }): number {
  return a.scopeId.localeCompare(b.scopeId) || a.ipAddress.localeCompare(b.ipAddress);
}
