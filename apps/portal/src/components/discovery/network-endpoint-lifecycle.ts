export type NetworkEndpointForLifecycle = {
  id: string;
  networkZoneId: string;
  ipAddress: string;
  observations?: Array<{ source: string; attribute: string; value: string | number | boolean }>;
};

export type LifecycleDeviceRecord = {
  id: string;
  displayName: string;
  tenantId: string;
  siteId: string;
  metadata?: Record<string, string | number | boolean>;
};

export type LifecyclePendingRecord = {
  key: string;
  details: Array<{ candidateId: string; physicalHardwareId: string | null; verificationStatus: string }>;
};

export type NetworkEndpointLifecycle = {
  endpointKey: string;
  stage: 'observed' | 'identified' | 'pending' | 'approved' | 'enrolled';
  recordId?: string;
  recordName?: string;
  relatedRecords?: number;
};

export function endpointLifecycleKey(endpoint: NetworkEndpointForLifecycle): string {
  return `${endpoint.networkZoneId}:${endpoint.ipAddress}:${endpoint.id}`;
}

/**
 * Links network evidence to the existing lifecycle only when the snapshot
 * contains a verified protocol identity and a record carries that same ID.
 * IP, MAC, hostname, vendor and model are deliberately not correlation keys.
 */
export function resolveNetworkEndpointLifecycle(
  endpoint: NetworkEndpointForLifecycle,
  pending: readonly LifecyclePendingRecord[],
  enrolled: readonly LifecycleDeviceRecord[],
  approved: readonly LifecycleDeviceRecord[],
): NetworkEndpointLifecycle {
  const key = endpointLifecycleKey(endpoint);
  if (!hasVerifiedProtocolIdentity(endpoint)) return { endpointKey: key, stage: 'observed' };

  const identity = normalize(endpoint.id);
  const enrolledMatches = enrolled.filter(device => devicePhysicalIds(device).some(id => id === identity));
  if (enrolledMatches.length) {
    const target = [...enrolledMatches].sort((a, b) => a.id.localeCompare(b.id))[0];
    return { endpointKey: key, stage: 'enrolled', recordId: target.id, recordName: target.displayName, relatedRecords: enrolledMatches.length };
  }

  const pendingMatches = pending.filter(record => record.details.some(detail =>
    detail.physicalHardwareId !== null &&
    normalize(detail.physicalHardwareId) === identity &&
    detail.verificationStatus !== 'conflict' &&
    detail.verificationStatus !== 'not_identified',
  ));
  if (pendingMatches.length) {
    const target = pendingMatches.length === 1 ? pendingMatches[0] : undefined;
    return { endpointKey: key, stage: 'pending', recordId: target?.key, recordName: target?.key, relatedRecords: pendingMatches.length };
  }

  const approvedMatches = approved.filter(device => devicePhysicalIds(device).some(id => id === identity));
  if (approvedMatches.length) {
    const target = [...approvedMatches].sort((a, b) => a.id.localeCompare(b.id))[0];
    return { endpointKey: key, stage: 'approved', recordId: target.id, recordName: target.displayName, relatedRecords: approvedMatches.length };
  }

  return { endpointKey: key, stage: 'identified' };
}

function hasVerifiedProtocolIdentity(endpoint: NetworkEndpointForLifecycle): boolean {
  return endpoint.observations?.some(observation =>
    (observation.source === 'http_rpc' && observation.attribute === 'shelly.device_id' && observation.value === endpoint.id) ||
    (observation.attribute === 'identity.verified' && observation.value === true),
  ) === true;
}

function devicePhysicalIds(device: LifecycleDeviceRecord): string[] {
  return [device.id, device.metadata?.physicalId, device.metadata?.hardwareId]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map(normalize);
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}
