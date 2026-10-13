import type { PowerAsset } from '@energrid/domain-telemetry';

export const LEGACY_POWER_CONFIG = Symbol('LEGACY_POWER_CONFIG');
export const LEGACY_POWER_CLIENT = Symbol('LEGACY_POWER_CLIENT');

export interface LegacyPowerBinding extends PowerAsset {
  sourceDeviceId: string;
}
export interface LegacyPowerConfig {
  uri: string | null;
  database: string;
  bindings: LegacyPowerBinding[];
}

export function legacyPowerConfig(env: NodeJS.ProcessEnv): LegacyPowerConfig {
  let input: unknown;
  try {
    input = JSON.parse(env.LEGACY_TELEMETRY_ASSETS || '[]');
  } catch {
    throw new Error('LEGACY_TELEMETRY_ASSETS must be a JSON array');
  }
  if (!Array.isArray(input))
    throw new Error('LEGACY_TELEMETRY_ASSETS must be a JSON array');
  const seen = new Set<string>();
  const bindings = input.map((entry: unknown): LegacyPowerBinding => {
    if (!entry || typeof entry !== 'object')
      throw new Error('Invalid legacy telemetry asset');
    const raw = entry as Record<string, unknown>;
    const text = (key: string) => {
      const value = raw[key];
      if (typeof value !== 'string' || !value.trim() || value.length > 120)
        throw new Error(`Invalid legacy asset ${key}`);
      return value.trim();
    };
    const id = text('id');
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || seen.has(id))
      throw new Error('Legacy asset IDs must be unique URL-safe names');
    seen.add(id);
    const timezone =
      typeof raw.timezone === 'string' ? raw.timezone : 'Europe/Sofia';
    try {
      new Intl.DateTimeFormat('en', { timeZone: timezone });
    } catch {
      throw new Error('Invalid legacy asset timezone');
    }
    const activeThresholdW = raw.activeThresholdW ?? 500;
    if (
      typeof activeThresholdW !== 'number' ||
      !Number.isFinite(activeThresholdW) ||
      activeThresholdW <= 0
    )
      throw new Error('Invalid active power threshold');
    const binding: LegacyPowerBinding = {
      id,
      displayName: text('displayName'),
      tenantId: text('tenantId'),
      siteId: text('siteId'),
      sourceDeviceId: text('sourceDeviceId'),
      timezone,
      activeThresholdW,
    };
    if (raw.capacityLiters !== undefined) {
      if (
        typeof raw.capacityLiters !== 'number' ||
        !Number.isFinite(raw.capacityLiters) ||
        raw.capacityLiters <= 0
      )
        throw new Error('Invalid tank capacity');
      binding.capacityLiters = raw.capacityLiters;
    }
    if (raw.schedule !== undefined) {
      const schedule = raw.schedule as Record<string, unknown> | null;
      const validTime = (value: unknown): value is string =>
        typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
      if (
        !schedule ||
        !validTime(schedule.start) ||
        !validTime(schedule.end) ||
        schedule.start === schedule.end
      )
        throw new Error('Invalid legacy asset schedule');
      binding.schedule = { start: schedule.start, end: schedule.end };
      if (schedule.effectiveFrom !== undefined) {
        const date = schedule.effectiveFrom;
        if (
          typeof date !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
          !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) ||
          new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date
        )
          throw new Error('Invalid schedule effective date');
        binding.schedule.effectiveFrom = date;
      }
    }
    return binding;
  });
  return {
    uri: env.LEGACY_TELEMETRY_MONGO_URI?.trim() || null,
    database: env.LEGACY_TELEMETRY_DATABASE || 'mqtt',
    bindings,
  };
}
