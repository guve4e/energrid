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
  identityValues?: string[];
  ambiguousIdentityValues?: string[];
  physicalAssignments?: Array<{ physicalDeviceId: string; componentKey?: string }>;
};

export type LifecyclePendingRecord = {
  key: string;
  tenantId?: string;
  siteId?: string;
  details: Array<{ candidateId: string; physicalHardwareId: string | null; verificationStatus: string }>;
};

export type NetworkEndpointLifecycle = {
  endpointKey: string;
  snapshotId?: string;
  stage: 'observed' | 'identified' | 'pending' | 'approved' | 'enrolled' | 'ambiguous';
  recordId?: string;
  recordName?: string;
  relatedRecords?: number;
};

export type NetworkSnapshotForLifecycle = {
  scanId: string;
  ownership?: { tenantId: string; siteId: string };
  endpoints: NetworkEndpointForLifecycle[];
};

export function endpointLifecycleKey(endpoint: NetworkEndpointForLifecycle): string {
  return `${endpoint.networkZoneId}:${endpoint.ipAddress}:${endpoint.id}`;
}

export function resolveNetworkSnapshotLifecycles(
  snapshots: readonly NetworkSnapshotForLifecycle[],
  pending: readonly LifecyclePendingRecord[],
  enrolled: readonly LifecycleDeviceRecord[],
  approved: readonly LifecycleDeviceRecord[],
): NetworkEndpointLifecycle[] {
  const result: NetworkEndpointLifecycle[] = [];
  for (const snapshot of snapshots) {
    if (!snapshot.ownership) {
      result.push(...snapshot.endpoints.map(endpoint => ({
        endpointKey: endpointLifecycleKey(endpoint),
        snapshotId: snapshot.scanId,
        stage: 'observed' as const,
      })));
      continue;
    }
    const { tenantId, siteId } = snapshot.ownership;
    result.push(...snapshot.endpoints.map(endpoint => ({
      ...resolveNetworkEndpointLifecycle(
        endpoint,
        pending.filter(record => record.tenantId === tenantId && record.siteId === siteId),
        enrolled.filter(record => record.tenantId === tenantId && record.siteId === siteId),
        approved.filter(record => record.tenantId === tenantId && record.siteId === siteId),
      ),
      snapshotId: snapshot.scanId,
    })));
  }
  return result;
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
  const identities = verifiedProtocolIdentityValues(endpoint);
  if (!identities.length) return { endpointKey: key, stage: 'observed' };

  const ambiguousPhysicalMatches = enrolled.filter(device =>
    (device.ambiguousIdentityValues || []).some(value => identities.includes(normalize(value))),
  );
  if (ambiguousPhysicalMatches.length) {
    return { endpointKey: key, stage: 'ambiguous', relatedRecords: ambiguousPhysicalMatches.length };
  }

  const enrolledMatches = enrolled.filter(device => devicePhysicalIds(device).some(id => identities.includes(id)));
  if (enrolledMatches.length > 1) {
    if (isOnePhysicalDeviceWithDistinctComponents(enrolledMatches)) {
      const target = [...enrolledMatches].sort((left, right) =>
        componentKeyFor(left).localeCompare(componentKeyFor(right)),
      )[0];
      return { endpointKey: key, stage: 'enrolled', recordId: target.id, recordName: target.displayName, relatedRecords: enrolledMatches.length };
    }
    return { endpointKey: key, stage: 'ambiguous', relatedRecords: enrolledMatches.length };
  }
  if (enrolledMatches.length === 1) {
    const target = enrolledMatches[0];
    return { endpointKey: key, stage: 'enrolled', recordId: target.id, recordName: target.displayName, relatedRecords: 1 };
  }

  const pendingMatches = pending.filter(record => record.details.some(detail =>
    detail.physicalHardwareId !== null &&
    identities.includes(normalize(detail.physicalHardwareId)) &&
    detail.verificationStatus !== 'conflict' &&
    detail.verificationStatus !== 'not_identified',
  ));
  if (pendingMatches.length) {
    if (pendingMatches.length > 1) return { endpointKey: key, stage: 'ambiguous', relatedRecords: pendingMatches.length };
    const target = pendingMatches[0];
    return { endpointKey: key, stage: 'pending', recordId: target?.key, recordName: target?.key, relatedRecords: pendingMatches.length };
  }

  const approvedMatches = approved.filter(device => devicePhysicalIds(device).some(id => identities.includes(id)));
  if (approvedMatches.length > 1) return { endpointKey: key, stage: 'ambiguous', relatedRecords: approvedMatches.length };
  if (approvedMatches.length === 1) {
    const target = approvedMatches[0];
    return { endpointKey: key, stage: 'approved', recordId: target.id, recordName: target.displayName, relatedRecords: 1 };
  }

  return { endpointKey: key, stage: 'identified' };
}

/** Multiple logical enrollments are one physical match only when the durable inventory
 * assignment proves a shared physical record and each logical record names a distinct component. */
function isOnePhysicalDeviceWithDistinctComponents(records: readonly LifecycleDeviceRecord[]): boolean {
  const assignments = records.map(record => record.physicalAssignments || []);
  if (assignments.some(items => items.length !== 1 || !items[0].physicalDeviceId || !items[0].componentKey)) return false;
  const physicalIds = new Set(assignments.map(items => items[0].physicalDeviceId));
  const componentKeys = assignments.map(items => items[0].componentKey!.trim().toLowerCase());
  return physicalIds.size === 1 && new Set(componentKeys).size === records.length;
}

function componentKeyFor(record: LifecycleDeviceRecord): string {
  return record.physicalAssignments?.[0]?.componentKey || record.id;
}

function verifiedProtocolIdentityValues(endpoint: NetworkEndpointForLifecycle): string[] {
  const observations = endpoint.observations || [];
  const verified = observations.some(observation =>
    observation.source === 'http_identity' && observation.attribute === 'identity.verified' && observation.value === true,
  );
  const protocolValues = observations.filter(observation =>
    (observation.source === 'http_rpc' && observation.attribute === 'shelly.device_id') ||
    (observation.source === 'http_identity' && observation.attribute === 'identity.device_id'),
  ).map(observation => observation.value).filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  return [...new Set(protocolValues.map(normalize))].filter(value =>
    observations.some(observation => observation.source === 'http_rpc' && observation.attribute === 'shelly.device_id' && normalize(String(observation.value)) === value) ||
    (verified && observations.some(observation => observation.source === 'http_identity' && observation.attribute === 'identity.device_id' && normalize(String(observation.value)) === value)),
  );
}

function devicePhysicalIds(device: LifecycleDeviceRecord): string[] {
  return [...(device.identityValues || []), device.id, device.metadata?.physicalId, device.metadata?.hardwareId]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map(normalize);
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}
