import type { PhysicalDeviceInventoryRecord } from '../devices/enrollment/physical-device-inventory.repository';
import type { KnownNetworkDevice } from '../devices/device-discovery-memory.store';
import type { NetworkDiscoveredDevice, RegisteredDevice } from '../devices/device-registry.types';
import { isNetworkObservationFresh } from '../devices/network-observation-freshness';

export interface PendingDeviceIdentityProjection {
  logicalCandidateId: string;
  physicalDeviceId: string | null;
  physicalHardwareId: string | null;
  componentId: string | null;
  ipAddress: string | null;
  macAddress: string | null;
  deviceReportedMacAddress: string | null;
  currentOccupantMacAddress: string | null;
  hostname: string | null;
  gatewayId: string | null;
  networkId: string | null;
  discoverySource: string;
  protocol: string;
  endpoint: string | null;
  evidenceSource: string;
  lastObservedAt: string | null;
  lastObservedIpAddress: string | null;
  lastObservedMacAddress: string | null;
  lastObservedDeviceReportedMacAddress: string | null;
  lastObservedHostname: string | null;
  lastObservedGatewayId: string | null;
  lastObservedNetworkId: string | null;
  verificationStatus: string;
  status: 'correlated' | 'protocol_observed' | 'not_identified' | 'conflict';
  networkAddressStatus: 'current' | 'historical' | 'reused' | null;
  reason: string;
}

const shellyIdentityNamespace = 'mqtt:shelly-protocol-id';

export function projectPendingDeviceIdentity(
  candidate: RegisteredDevice,
  inventory: readonly PhysicalDeviceInventoryRecord[],
  networkDevices: readonly NetworkDiscoveredDevice[],
  inventoryAvailable = true,
  networkHistory: readonly KnownNetworkDevice[] = [],
  now: () => number = Date.now,
): PendingDeviceIdentityProjection {
  const metadata = candidate.metadata ?? {};
  const physicalHardwareId = stringField(metadata.physicalId);
  const componentId = stringField(metadata.component);
  const base = {
    logicalCandidateId: candidate.id,
    physicalHardwareId,
    componentId,
    discoverySource: candidate.discovery?.source ?? 'unknown',
    protocol: candidate.adapter.protocol,
    endpoint: candidate.adapter.target ?? null,
    ipAddress: null,
    macAddress: null,
    deviceReportedMacAddress: null,
    currentOccupantMacAddress: null,
    hostname: null,
    gatewayId: null,
    networkId: null,
    lastObservedAt: candidate.state.observedAt,
    lastObservedIpAddress: null,
    lastObservedMacAddress: null,
    lastObservedDeviceReportedMacAddress: null,
    lastObservedHostname: null,
    lastObservedGatewayId: null,
    lastObservedNetworkId: null,
    networkAddressStatus: null,
  } as const;

  if (!physicalHardwareId) {
    return {
      ...base,
      physicalDeviceId: null,
      evidenceSource: candidate.adapter.protocol === 'mqtt' ? 'MQTT status/evidence' : candidate.discovery?.source ?? 'unknown',
      verificationStatus: 'not_identified',
      status: 'not_identified',
      reason: candidate.adapter.protocol === 'mqtt'
        ? 'MQTT evidence identifies a logical source but contains no stable hardware identifier; its topic is only a communication address.'
        : 'No stable physical hardware identifier is present in the available discovery evidence.',
    };
  }

  if (!inventoryAvailable) {
    return {
      ...base,
      physicalDeviceId: null,
      evidenceSource: 'candidate protocol metadata',
      verificationStatus: 'protocol_observed',
      status: 'protocol_observed',
      reason: 'Physical-device inventory could not be read, so LAN evidence cannot be safely reconciled for this candidate.',
    };
  }

  const claimMatches = inventory.filter(record =>
    record.scope.tenantId === candidate.tenantId &&
    record.scope.siteId === candidate.siteId &&
    record.identity?.namespace === shellyIdentityNamespace &&
    sameProtocolId(record.identity.value, physicalHardwareId),
  );
  const componentInCandidate = componentId !== null && claimMatches.some(record =>
    record.components.some(component => component.key === componentId),
  );

  if (claimMatches.length > 1) {
    return {
      ...base,
      physicalDeviceId: null,
      evidenceSource: 'physical-device inventory',
      verificationStatus: 'conflict',
      status: 'conflict',
      reason: 'The same protocol hardware identifier resolves to multiple physical inventory records; network details were withheld.',
    };
  }

  const physical = claimMatches[0];
  if (!physical) {
    return {
      ...base,
      physicalDeviceId: null,
      evidenceSource: 'candidate protocol metadata',
      verificationStatus: 'protocol_observed',
      status: 'protocol_observed',
      reason: 'A protocol-reported hardware identifier exists, but no matching physical inventory claim is available.',
    };
  }

  if (!componentInCandidate) {
    return {
      ...base,
      physicalDeviceId: physical.physicalDeviceId,
      evidenceSource: physical.identityEvidenceSource ?? 'physical-device inventory',
      lastObservedAt: physical.identityLastObservedAt ?? physical.lastSeenAt,
      verificationStatus: physical.verificationStatus,
      status: 'protocol_observed',
      reason: 'The physical protocol identifier is recorded, but this logical component is absent from the inventory evidence.',
    };
  }

  const matchingNetwork = networkDevices.filter(device =>
    device.status === 'online' &&
    sameProtocolId(device.id, physicalHardwareId) &&
    device.components?.some(component => component.component === componentId),
  );
  const matchingHistory = networkHistory.filter(record =>
    sameProtocolId(record.device.id, physicalHardwareId) &&
    record.device.components?.some(component => component.component === componentId),
  );
  const nowMs = now();
  const freshNetwork = matchingNetwork.filter(device =>
    isNetworkObservationFresh(device.discoveredAt, nowMs),
  );
  const expiredNetwork = matchingNetwork
    .filter(device => !isNetworkObservationFresh(device.discoveredAt, nowMs))
    .map(device => ({ device, lastSeenAt: device.discoveredAt, persisted: false }));
  const persistedHistory = matchingHistory.map(record => ({ ...record, persisted: true }));
  const allEvidence = [
    ...matchingNetwork.map(device => ({ device, observedAt: device.discoveredAt, current: true })),
    ...matchingHistory.map(record => ({ device: record.device, observedAt: record.lastSeenAt, current: false })),
  ];
  const matchingScopes = new Set(allEvidence.map(({ device }) => networkScope(device)));
  if (allEvidence.some(({ device }) => device.identityConflict) || matchingScopes.size > 1) {
    return {
      ...base,
      physicalDeviceId: physical.physicalDeviceId,
      evidenceSource: 'Shelly MQTT identity + LAN HTTP/RPC identity',
      lastObservedAt: latestTimestamp(physical.identityLastObservedAt, ...allEvidence.map(({ observedAt }) => observedAt)),
      verificationStatus: 'conflict',
      status: 'conflict',
      reason: matchingScopes.size > 1
        ? 'The protocol identity is visible in multiple network scopes; IP and MAC were withheld.'
        : 'LAN discovery reports conflicting MAC evidence for this endpoint; IP and MAC were withheld.',
    };
  }

  const observed = freshNetwork.sort((a, b) => b.discoveredAt.localeCompare(a.discoveredAt))[0];
  const historical = [...persistedHistory, ...expiredNetwork]
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))[0];
  const lastObservation = observed ?? (historical ? { ...historical.device, discoveredAt: historical.lastSeenAt } : null);
  if (!lastObservation) {
    return {
      ...base,
      physicalDeviceId: physical.physicalDeviceId,
      evidenceSource: physical.identityEvidenceSource ?? 'Shelly MQTT protocol identity',
      lastObservedAt: physical.identityLastObservedAt ?? physical.lastSeenAt,
      verificationStatus: physical.verificationStatus,
      status: 'protocol_observed',
      reason: 'The hardware ID and component are in physical inventory, but no current LAN observation with the exact same Shelly ID and component is available.',
    };
  }

  const observationFields = {
    lastObservedAt: lastObservation.discoveredAt,
    lastObservedIpAddress: lastObservation.ipAddress,
    lastObservedMacAddress: lastObservation.macAddress ?? null,
    lastObservedDeviceReportedMacAddress: lastObservation.deviceReportedMacAddress ?? null,
    lastObservedHostname: lastObservation.hostname ?? null,
    lastObservedGatewayId: lastObservation.gatewayId ?? null,
    lastObservedNetworkId: lastObservation.networkZoneName || lastObservation.networkZoneId,
  };

  if (!observed) {
    const reusedAddress = historical
      ? currentMacAtHistoricalAddress(historical.device, networkDevices)
      : null;
    return {
      ...base,
      ...observationFields,
      physicalDeviceId: physical.physicalDeviceId,
      evidenceSource: `${physical.identityEvidenceSource ?? 'Shelly MQTT protocol identity'} + ${historical.persisted ? 'persisted_lan_discovery_memory' : 'expired_lan_scan_observation'}`,
      currentOccupantMacAddress: reusedAddress?.macAddress ?? null,
      networkAddressStatus: reusedAddress ? 'reused' : 'historical',
      verificationStatus: physical.verificationStatus,
      status: 'protocol_observed',
      reason: reusedAddress
        ? `Exact Shelly protocol hardware ID and component match persisted LAN HTTP/RPC evidence. Historical IP ${reusedAddress.ipAddress} is now observed in the same network scope with a different MAC (${reusedAddress.macAddress}); the historical lease is retained and is not current.`
        : 'Exact Shelly protocol hardware ID and component match persisted LAN HTTP/RPC evidence. These are historical last-observed network details; run a new LAN scan to confirm the current address.',
    };
  }

  return {
    ...base,
    ...observationFields,
    physicalDeviceId: physical.physicalDeviceId,
    ipAddress: observed.ipAddress,
    macAddress: observed.macAddress ?? null,
    deviceReportedMacAddress: observed.deviceReportedMacAddress ?? null,
    hostname: observed.hostname ?? null,
    gatewayId: observed.gatewayId ?? null,
    networkId: observed.networkZoneId,
    evidenceSource: `${physical.identityEvidenceSource ?? 'Shelly MQTT protocol identity'} + lan_http_rpc`,
    lastObservedAt: observed.discoveredAt,
    verificationStatus: physical.verificationStatus,
    status: 'correlated',
    networkAddressStatus: 'current',
    reason: 'Exact Shelly protocol hardware ID and component match current LAN HTTP/RPC evidence. This is protocol correlation, not independent hardware authentication.',
  };
}

function currentMacAtHistoricalAddress(
  historical: NetworkDiscoveredDevice,
  currentDevices: readonly NetworkDiscoveredDevice[],
): { ipAddress: string; macAddress: string } | null {
  if (!historical.macAddress) return null;
  const current = currentDevices.find(device =>
    device.status === 'online' &&
    device.ipAddress === historical.ipAddress &&
    networkScope(device) === networkScope(historical) &&
    !!device.macAddress &&
    device.macAddress.toLowerCase() !== historical.macAddress!.toLowerCase() &&
    Date.parse(device.discoveredAt) > Date.parse(historical.discoveredAt),
  );
  return current?.macAddress ? { ipAddress: historical.ipAddress, macAddress: current.macAddress } : null;
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function sameProtocolId(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function networkScope(device: NetworkDiscoveredDevice): string {
  return `${device.gatewayId ?? 'gateway-unknown'}:${device.networkZoneId}`;
}

function latestTimestamp(...values: Array<string | undefined>): string | null {
  return values.filter((value): value is string => !!value)
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
}
