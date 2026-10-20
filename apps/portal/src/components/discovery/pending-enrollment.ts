export interface PendingCandidateInput {
  id: string;
  tenantId: string;
  siteId: string;
  displayName: string;
  trustStatus: 'discovered' | 'approved' | 'blocked';
  kind: string;
  capabilities: Array<{ kind: string; actions: string[] }>;
  adapter: { protocol: string; target?: string };
  discovery?: {
    source: string;
    confidence: number;
    suggestedName?: string;
    reason: string;
  };
  metadata?: Record<string, string | number | boolean>;
}

export interface PendingIdentityInput {
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

export interface PendingCandidateDetails {
  candidateId: string;
  logicalCandidateId: string;
  displayName: string;
  componentId: string | null;
  capabilities: string[];
  source: string;
  protocol: string;
  endpoint: string | null;
  physicalHardwareId: string | null;
  physicalDeviceId: string | null;
  evidenceSource: string;
  observedAt: string | null;
  confidence: number | null;
  verificationStatus: string;
  networkAddressStatus: 'current' | 'historical' | 'reused' | null;
  reason: string;
  retired: boolean;
}

export interface PendingEnrollmentCardModel {
  key: string;
  title: string;
  typeLabel: string;
  protocolLabel: string;
  lifecycleLabel: string;
  networkLabel: 'Recently confirmed' | 'Last observed' | 'Not established';
  networkObservedAt: string | null;
  ipAddress: string | null;
  macAddress: string | null;
  deviceReportedMacAddress: string | null;
  currentOccupantMacAddress: string | null;
  hostname: string | null;
  network: string | null;
  networkEvidenceStatus: string | null;
  unknownNetworkMessage: string | null;
  componentSummary: string;
  components: string[];
  capabilities: string[];
  details: PendingCandidateDetails[];
}

export function buildPendingEnrollmentCards(
  candidates: readonly PendingCandidateInput[],
  identities: Readonly<Record<string, PendingIdentityInput | undefined>>,
): PendingEnrollmentCardModel[] {
  const groups = new Map<string, PendingCandidateInput[]>();
  for (const candidate of candidates) {
    const identity = identities[candidate.id];
    const key = groupKey(candidate, identity);
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }

  return [...groups.entries()]
    .map(([key, group]) => toCard(key, group, identities))
    .sort((left, right) => left.title.localeCompare(right.title));
}

function groupKey(
  candidate: PendingCandidateInput,
  identity: PendingIdentityInput | undefined,
): string {
  if (identity?.status !== 'not_identified' && identity?.physicalDeviceId &&
    identity.physicalHardwareId && identity.componentId) {
    return [candidate.tenantId, candidate.siteId, identity.physicalDeviceId, identity.physicalHardwareId]
      .join(':');
  }
  return `candidate:${candidate.tenantId}:${candidate.siteId}:${candidate.id}`;
}

function toCard(
  key: string,
  group: readonly PendingCandidateInput[],
  identities: Readonly<Record<string, PendingIdentityInput | undefined>>,
): PendingEnrollmentCardModel {
  const candidates = [...group].sort((left, right) =>
    (identities[left.id]?.componentId ?? left.id).localeCompare(identities[right.id]?.componentId ?? right.id),
  );
  const primary = candidates[0];
  const networkIdentities = candidates.map(candidate => identities[candidate.id]).filter(isIdentity);
  const currentIdentities = networkIdentities.filter(item => item.ipAddress);
  const historicalIdentities = networkIdentities
    .filter(item => item.lastObservedIpAddress)
    .sort((left, right) => (right.lastObservedAt ?? '').localeCompare(left.lastObservedAt ?? ''));
  const observedMacs = unique(networkIdentities.flatMap(item => [item.macAddress, item.lastObservedMacAddress]).filter(isString));
  const networkScopes = unique(networkIdentities
    .map(item => join(item.networkId ?? item.lastObservedNetworkId, item.gatewayId ?? item.lastObservedGatewayId))
    .filter(isString));
  const hasConflict = networkIdentities.some(item => item.status === 'conflict') || observedMacs.length > 1 || networkScopes.length > 1;
  const identity = currentIdentities[0] ?? historicalIdentities[0] ?? networkIdentities[0];
  const newestObservation = [...networkIdentities]
    .filter(item => item.lastObservedAt)
    .sort((left, right) => (right.lastObservedAt ?? '').localeCompare(left.lastObservedAt ?? ''))[0];
  const live = !hasConflict && currentIdentities.length > 0;
  const ipAddress = hasConflict ? null : live
    ? currentIdentities.sort((left, right) => (right.lastObservedAt ?? '').localeCompare(left.lastObservedAt ?? ''))[0].ipAddress
    : historicalIdentities[0]?.lastObservedIpAddress ?? null;
  const components = unique(candidates.map(candidate => identities[candidate.id]?.componentId).filter(isString));
  const capabilities = unique(candidates.flatMap(candidate => candidate.capabilities.map(capability => capability.kind)));
  const details = candidates.map(candidate => detail(candidate, identities[candidate.id]));

  return {
    key,
    title: primary.discovery?.suggestedName || primary.displayName,
    typeLabel: capabilities.length ? capabilities.join(' · ') : primary.kind,
    protocolLabel: unique(candidates.map(candidate => identities[candidate.id]?.protocol || candidate.adapter.protocol)).join(' + '),
    lifecycleLabel: candidates.some(candidate => candidate.metadata?.previouslyEnrolledRetired === true)
      ? 'Previously enrolled · Retired'
      : 'Pending approval',
    networkLabel: ipAddress ? live ? 'Recently confirmed' : 'Last observed' : 'Not established',
    networkObservedAt: ipAddress ? newestObservation?.lastObservedAt ?? null : null,
    ipAddress,
    macAddress: hasConflict ? null : live ? identity?.macAddress ?? null : identity?.lastObservedMacAddress ?? null,
    deviceReportedMacAddress: hasConflict ? null : live
      ? identity?.deviceReportedMacAddress ?? null
      : identity?.lastObservedDeviceReportedMacAddress ?? null,
    currentOccupantMacAddress: hasConflict ? null : identity?.currentOccupantMacAddress ?? null,
    hostname: hasConflict ? null : live ? identity?.hostname ?? null : identity?.lastObservedHostname ?? null,
    network: live
      ? join(identity?.networkId, identity?.gatewayId)
      : hasConflict ? null : join(identity?.lastObservedNetworkId, identity?.lastObservedGatewayId),
    networkEvidenceStatus: ipAddress && !live
      ? networkIdentities.some(item => item.networkAddressStatus === 'reused')
        ? 'Historical · IP now observed with a different MAC'
      : 'Historical · not recently confirmed'
      : null,
    unknownNetworkMessage: ipAddress ? null : hasConflict
      ? 'Network identity conflict — address withheld'
      : candidates.every(candidate => candidate.adapter.protocol === 'mqtt')
        ? 'MQTT source — network address not established'
        : identity?.reason || 'No network address has been observed for this candidate.',
    componentSummary: components.length > 1
      ? `${components.length} components`
      : components.length === 1 ? components[0] : 'Component not identified',
    components,
    capabilities,
    details,
  };
}

function detail(
  candidate: PendingCandidateInput,
  identity: PendingIdentityInput | undefined,
): PendingCandidateDetails {
  return {
    candidateId: candidate.id,
    logicalCandidateId: candidate.id,
    displayName: candidate.discovery?.suggestedName || candidate.displayName,
    componentId: identity?.componentId ?? null,
    capabilities: candidate.capabilities.map(capability => capability.kind),
    source: identity?.discoverySource || candidate.discovery?.source || 'unknown',
    protocol: identity?.protocol || candidate.adapter.protocol,
    endpoint: identity?.endpoint || candidate.adapter.target || null,
    physicalHardwareId: identity?.physicalHardwareId ?? null,
    physicalDeviceId: identity?.physicalDeviceId ?? null,
    evidenceSource: identity?.evidenceSource || candidate.discovery?.source || 'unknown',
    observedAt: identity?.lastObservedAt ?? null,
    confidence: candidate.discovery?.confidence ?? null,
    verificationStatus: identity?.verificationStatus || 'not_identified',
    networkAddressStatus: identity?.networkAddressStatus ?? null,
    reason: identity?.reason || 'Backend identity evidence is unavailable.',
    retired: candidate.metadata?.previouslyEnrolledRetired === true,
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isIdentity(value: PendingIdentityInput | undefined): value is PendingIdentityInput {
  return value !== undefined;
}

function join(...values: Array<string | null | undefined>): string | null {
  const result = values.filter(isString);
  return result.length ? result.join(' · ') : null;
}
