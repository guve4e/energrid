export type DeviceDetailMetric = 'temperature' | 'humidity';

export interface DeviceDetailCapability {
  kind: string;
  actions: string[];
  unit?: string;
}

export interface DeviceDetailContract {
  capabilities: DeviceDetailCapability[];
  supportedCapabilities?: DeviceDetailCapability[];
}

export interface DeviceDetailPresentation {
  climateMetrics: DeviceDetailMetric[];
  showElectrical: boolean;
  showRelayState: boolean;
  showUnknownCapabilities: boolean;
  measurementApprovalNeeded: DeviceDetailMetric[];
}

/** Derives display sections from verified support while keeping observation authority separate. */
export function deviceDetailPresentation(
  device: DeviceDetailContract,
  boundMetrics: DeviceDetailMetric[] = [],
  authorizedBindings: DeviceDetailMetric[] = [],
): DeviceDetailPresentation {
  // An authorized read capability is itself verified evidence of support. Keep
  // it visible when an older registry snapshot omits it from the support list.
  const supported = [...(device.supportedCapabilities ?? []), ...device.capabilities];
  const supportedKinds = new Set(supported.map(capability => capability.kind));
  const authorizedReadKinds = new Set([...device.capabilities
    .filter(capability => capability.actions.includes('read'))
    .map(capability => capability.kind), ...authorizedBindings]);
  const climateMetrics = (['temperature', 'humidity'] as const)
    .filter(metric => supportedKinds.has(metric) || boundMetrics.includes(metric) || authorizedBindings.includes(metric));
  return {
    climateMetrics: [...climateMetrics],
    showElectrical: supportedKinds.has('power'),
    showRelayState: supportedKinds.has('switch') || supported.some(capability =>
      capability.actions.includes('turn_on') || capability.actions.includes('turn_off')),
    showUnknownCapabilities: supportedKinds.size === 0,
    measurementApprovalNeeded: climateMetrics.filter(metric => !authorizedReadKinds.has(metric)),
  };
}

export function relayStateFreshness(
  status: string,
  observedAt: string | null,
  now = Date.now(),
  staleAfterMs = 5 * 60_000,
): 'offline' | 'unknown' | 'stale' | 'fresh' {
  const timestamp = observedAt ? Date.parse(observedAt) : Number.NaN;
  if (!Number.isFinite(timestamp) || timestamp > now + 30_000) return 'unknown';
  if (now - timestamp > staleAfterMs) return 'stale';
  if (['offline', 'disconnected'].includes(status.toLowerCase())) return 'offline';
  return ['online', 'healthy', 'connected'].includes(status.toLowerCase()) ? 'fresh' : 'unknown';
}

export function relayStateValue(values: Record<string, unknown>): boolean | null {
  for (const key of ['on', 'output', 'switch', 'powered']) {
    if (typeof values[key] === 'boolean') return values[key] as boolean;
  }
  return null;
}
