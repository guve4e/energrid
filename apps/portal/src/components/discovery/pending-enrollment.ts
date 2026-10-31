export interface PendingCandidateInput {
  id: string;
  tenantId: string;
  siteId: string;
  displayName: string;
  trustStatus: 'discovered' | 'approved' | 'blocked';
  kind: string;
  capabilities: Array<{ kind: string; actions: string[] }>;
  adapter: { protocol: string; target?: string; driver?: string };
  discovery?: {
    source: string;
    confidence: number;
    suggestedName?: string;
    reason: string;
  };
  metadata?: Record<string, string | number | boolean>;
  zoneId?: string;
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
  brokerObservedPeerIpAddress: string | null;
  brokerObservedAt: string | null;
  brokerIdentityVerification: string | null;
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
  requiresEnrollmentPlacement: boolean;
  requiresShellyLanVerification: boolean;
  shellyLanVerificationReason: string | null;
  canVerifyShelly: boolean;
  identityVerificationObservedAt: string | null;
  componentVerificationObservedAt: string | null;
  brokerObservedPeerIpAddress: string | null;
  brokerObservedAt: string | null;
  brokerIdentityVerification: string | null;
}

export interface PendingEnrollmentCardModel {
  key: string;
  tenantId: string;
  siteId: string;
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
  brokerObservedPeerIpAddress: string | null;
  brokerObservedAt: string | null;
  brokerIdentityVerification: string | null;
  unknownNetworkMessage: string | null;
  componentSummary: string;
  components: string[];
  capabilities: string[];
  details: PendingCandidateDetails[];
}

export function buildPendingEnrollmentCards(
  candidates: readonly PendingCandidateInput[],
  identities: Readonly<Record<string, PendingIdentityInput | undefined>>,
  now = Date.now(),
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
    .map(([key, group]) => toCard(key, group, identities, now))
    .sort((left, right) => left.title.localeCompare(right.title));
}

function groupKey(
  candidate: PendingCandidateInput,
  identity: PendingIdentityInput | undefined,
): string {
  if (candidate.metadata?.identityEvidenceSource === 'mqtt-claimed-protocol-id' &&
      typeof candidate.metadata.physicalId === 'string' && candidate.metadata.physicalId) {
    // Component candidates with the same unverified protocol claim are one
    // physical-device card. This is presentation grouping only; it does not
    // verify identity or grant enrollment/measurement authority.
    return [candidate.tenantId, candidate.siteId, 'mqtt-claim', candidate.metadata.physicalId].join(':');
  }
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
  now: number,
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
  const newestBrokerEvidence = [...networkIdentities]
    .filter(item => item.brokerObservedAt)
    .sort((left, right) => (right.brokerObservedAt ?? '').localeCompare(left.brokerObservedAt ?? ''))[0];
  const live = !hasConflict && currentIdentities.length > 0;
  const ipAddress = hasConflict ? null : live
    ? currentIdentities.sort((left, right) => (right.lastObservedAt ?? '').localeCompare(left.lastObservedAt ?? ''))[0].ipAddress
    : historicalIdentities[0]?.lastObservedIpAddress ?? null;
  const components = unique(candidates.map(candidate =>
    identities[candidate.id]?.componentId ||
    (typeof candidate.metadata?.component === 'string' ? candidate.metadata.component : ''),
  ).filter(isString));
  const capabilities = unique(candidates.flatMap(candidate => candidate.capabilities.map(capability => capability.kind)));
  const details = candidates.map(candidate => detail(candidate, identities[candidate.id], now));

  return {
    key,
    tenantId: primary.tenantId,
    siteId: primary.siteId,
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
    brokerObservedPeerIpAddress: newestBrokerEvidence?.brokerObservedPeerIpAddress ?? null,
    brokerObservedAt: newestBrokerEvidence?.brokerObservedAt ?? null,
    brokerIdentityVerification: newestBrokerEvidence?.brokerIdentityVerification ?? null,
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
  now: number,
): PendingCandidateDetails {
  const shelly = /^shelly[a-z0-9._-]{1,114}$/i.test(String(candidate.metadata?.physicalId || identity?.physicalHardwareId || ''));
  const shellyLanVerificationReason = shelly ? getShellyLanVerificationReason(candidate, now) : null;
  return {
    candidateId: candidate.id,
    logicalCandidateId: candidate.id,
    displayName: candidate.discovery?.suggestedName || candidate.displayName,
    componentId: identity?.componentId ??
      (typeof candidate.metadata?.component === 'string' ? candidate.metadata.component : null),
    capabilities: candidate.capabilities.map(capability => capability.kind),
    source: identity?.discoverySource || candidate.discovery?.source || 'unknown',
    protocol: identity?.protocol || candidate.adapter.protocol,
    endpoint: identity?.endpoint || candidate.adapter.target || null,
    physicalHardwareId: identity?.physicalHardwareId ?? null,
    physicalDeviceId: identity?.physicalDeviceId ?? null,
    evidenceSource: identity?.evidenceSource ||
      (candidate.metadata?.identityEvidenceSource === 'mqtt-claimed-protocol-id'
        ? 'MQTT protocol message (identity claim)' : candidate.discovery?.source || 'unknown'),
    observedAt: identity?.lastObservedAt ??
      (typeof candidate.metadata?.mqttObservedAt === 'string' ? candidate.metadata.mqttObservedAt : null),
    confidence: candidate.discovery?.confidence ?? null,
    verificationStatus: identity?.verificationStatus ||
      (candidate.metadata?.verificationStatus === 'unverified' ? 'unverified' : 'not_identified'),
    networkAddressStatus: identity?.networkAddressStatus ?? null,
    reason: identity?.reason || candidate.discovery?.reason || 'Backend identity evidence is unavailable.',
    retired: candidate.metadata?.previouslyEnrolledRetired === true,
    requiresEnrollmentPlacement: candidate.metadata?.observationApprovalRequired === true || candidate.metadata?.requiresEnrollmentPlacement === true,
    requiresShellyLanVerification: shellyLanVerificationReason !== null,
    shellyLanVerificationReason,
    canVerifyShelly: shellyLanVerificationReason !== null && candidate.adapter.driver === 'shelly-lan' &&
      /^shelly[a-z0-9._-]{1,114}$/i.test(String(candidate.metadata?.physicalId || '')) &&
      /^(?:switch|em1):\d+$/.test(String(candidate.metadata?.component || '')) &&
      /^(?:\d{1,3}\.){3}\d{1,3}$/.test(String(candidate.metadata?.ipAddress || '')) &&
      typeof candidate.metadata?.networkScope === 'string' && candidate.metadata.networkScope.length > 0,
    identityVerificationObservedAt: typeof candidate.metadata?.identityVerifiedAt === 'string' ? candidate.metadata.identityVerifiedAt : null,
    componentVerificationObservedAt: typeof candidate.metadata?.componentVerifiedAt === 'string' ? candidate.metadata.componentVerifiedAt : null,
    brokerObservedPeerIpAddress: identity?.brokerObservedPeerIpAddress ?? null,
    brokerObservedAt: identity?.brokerObservedAt ?? null,
    brokerIdentityVerification: identity?.brokerIdentityVerification ?? null,
  };
}

/** Keep the review UI aligned with DeviceOnboardingService's fail-closed evidence gate. */
function getShellyLanVerificationReason(candidate: PendingCandidateInput, now: number): string | null {
  if (candidate.adapter.driver !== 'shelly-lan') {
    return 'this candidate is not backed by a Shelly LAN/RPC discovery record';
  }

  const identitySource = candidate.metadata?.identityEvidenceSource;
  const componentSource = candidate.metadata?.componentEvidenceSource;
  const directRpc = identitySource === 'verified_shelly_http_rpc' &&
    componentSource === 'verified_shelly_component_status_rpc';
  const siteLocalRpc = identitySource === 'verified_site_local_shelly_rpc' &&
    componentSource === 'verified_site_local_shelly_rpc';
  if (!directRpc && !siteLocalRpc) {
    return 'independent Shelly LAN identity and component RPC evidence is missing';
  }
  if (siteLocalRpc && !(typeof candidate.metadata?.siteLocalObserverId === 'string' && candidate.metadata.siteLocalObserverId.length > 0)) {
    return 'the site-local RPC report has no recorded observer identity';
  }

  const component = String(candidate.metadata?.component || '');
  const channel = /^(switch|em1):(\d+)$/.exec(component);
  const expectedMethod = channel
    ? `${channel[1] === 'switch' ? 'Switch' : 'EM1'}.GetStatus?id=${channel[2]}`
    : '';
  if (candidate.metadata?.identityVerificationMethod !== 'GET /rpc/Shelly.GetDeviceInfo') {
    return 'the Shelly device identity RPC verification method is missing or does not match';
  }
  if (!expectedMethod || candidate.metadata?.componentVerificationMethod !== expectedMethod) {
    return 'the component status RPC verification method does not match the selected component';
  }

  for (const [label, value] of [
    ['device identity', candidate.metadata?.identityVerifiedAt],
    ['component status', candidate.metadata?.componentVerifiedAt],
  ] as const) {
    const timestamp = Date.parse(String(value || ''));
    if (!Number.isFinite(timestamp)) return `the ${label} verification timestamp is missing or invalid`;
    if (timestamp > now) return `the ${label} verification timestamp is in the future`;
    if (now - timestamp > 15 * 60_000) return `the ${label} verification is older than 15 minutes`;
  }
  return null;
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
