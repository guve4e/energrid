import {
  readingIdentifier,
  utcInstant,
  type PowerAsset,
} from '@energrid/domain-telemetry';

export const CANONICAL_POWER_CONFIG = Symbol('CANONICAL_POWER_CONFIG');
export interface MeterAssignment {
  deviceId: string;
  channel: string;
  from: string;
  to?: string;
}
export interface CanonicalPowerBinding extends PowerAsset {
  meters: MeterAssignment[];
}
export interface CanonicalPowerConfig {
  source: 'legacy' | 'telemetry';
  bindings: CanonicalPowerBinding[];
}

export function canonicalPowerConfig(
  env: NodeJS.ProcessEnv,
): CanonicalPowerConfig {
  const source = env.ENERGY_HISTORY_SOURCE || 'legacy';
  if (source !== 'legacy' && source !== 'telemetry')
    throw new Error('Invalid ENERGY_HISTORY_SOURCE');
  let input: unknown;
  try {
    input = JSON.parse(env.TELEMETRY_POWER_ASSETS || '[]');
  } catch {
    throw new Error('TELEMETRY_POWER_ASSETS must be a JSON array');
  }
  if (!Array.isArray(input))
    throw new Error('TELEMETRY_POWER_ASSETS must be a JSON array');
  const seen = new Set<string>();
  const bindings = input.map((entry): CanonicalPowerBinding => {
    if (!entry || typeof entry !== 'object')
      throw new Error('Invalid telemetry power asset');
    const raw = entry as Record<string, unknown>;
    const id = readingIdentifier(raw.id);
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || seen.has(id))
      throw new Error('Power asset IDs must be unique URL-safe names');
    seen.add(id);
    if (
      typeof raw.displayName !== 'string' ||
      !raw.displayName.trim() ||
      raw.displayName.length > 120
    )
      throw new Error('Invalid power asset display name');
    const timezone =
      typeof raw.timezone === 'string' ? raw.timezone : 'Europe/Sofia';
    new Intl.DateTimeFormat('en', { timeZone: timezone });
    const positive = (value: unknown) =>
      typeof value === 'number' && Number.isFinite(value) && value > 0;
    const activeThresholdW = raw.activeThresholdW ?? 500;
    if (!positive(activeThresholdW))
      throw new Error('Invalid active power threshold');
    if (
      !Array.isArray(raw.meters) ||
      !raw.meters.length ||
      raw.meters.length > 32
    )
      throw new Error('Expected between one and 32 dated meter assignments');
    const meters = raw.meters
      .map((m: Record<string, unknown>) => {
        if (!m || typeof m !== 'object')
          throw new Error('Invalid meter assignment');
        const from = utcInstant(m.from),
          to = m.to === undefined ? undefined : utcInstant(m.to);
        if (to && to <= from)
          throw new Error('Invalid meter assignment interval');
        return {
          deviceId: readingIdentifier(m.deviceId),
          channel: readingIdentifier(m.channel),
          from,
          ...(to ? { to } : {}),
        };
      })
      .sort((a, b) => a.from.localeCompare(b.from));
    for (let i = 1; i < meters.length; i++)
      if (!meters[i - 1].to || meters[i].from < meters[i - 1].to!)
        throw new Error('Meter assignments for an asset must not overlap');
    const asset: CanonicalPowerBinding = {
      id,
      displayName: raw.displayName.trim(),
      tenantId: readingIdentifier(raw.tenantId),
      siteId: readingIdentifier(raw.siteId),
      timezone,
      activeThresholdW: activeThresholdW as number,
      meters,
      measurementSources: meters.map((m) => ({
        deviceId: m.deviceId,
        channel: m.channel,
        from: m.from,
        ...(m.to ? { to: m.to } : {}),
      })),
    };
    if (raw.capacityLiters !== undefined) {
      if (!positive(raw.capacityLiters))
        throw new Error('Invalid tank capacity');
      asset.capacityLiters = raw.capacityLiters as number;
    }
    if (raw.schedule !== undefined) {
      const s = raw.schedule as Record<string, unknown> | null;
      const time = (v: unknown): v is string =>
        typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
      if (!s || !time(s.start) || !time(s.end) || s.start === s.end)
        throw new Error('Invalid asset schedule');
      asset.schedule = { start: s.start, end: s.end };
      if (s.effectiveFrom !== undefined) {
        if (
          typeof s.effectiveFrom !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}$/.test(s.effectiveFrom)
        )
          throw new Error('Invalid schedule effective date');
        utcInstant(`${s.effectiveFrom}T00:00:00Z`);
        asset.schedule.effectiveFrom = s.effectiveFrom;
      }
    }
    return asset;
  });
  // One physical measurement cannot be counted as two independent appliance histories.
  for (let i = 0; i < bindings.length; i++)
    for (let j = 0; j < i; j++) {
      const a = bindings[i],
        b = bindings[j];
      if (a.tenantId !== b.tenantId || a.siteId !== b.siteId) continue;
      for (const x of a.meters)
        for (const y of b.meters)
          if (
            x.deviceId === y.deviceId &&
            x.channel === y.channel &&
            x.from < (y.to ?? '9999') &&
            y.from < (x.to ?? '9999')
          )
            throw new Error(
              'A meter channel cannot be assigned to overlapping assets',
            );
    }
  return { source, bindings };
}
