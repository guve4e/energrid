import { isAbsolute } from 'node:path';

export const TELEMETRY_POOL = Symbol('TELEMETRY_POOL');
export const TELEMETRY_CONFIG = Symbol('TELEMETRY_CONFIG');
export const TELEMETRY_SPOOL_FACTORY = Symbol('TELEMETRY_SPOOL_FACTORY');

export interface TelemetryConfig {
  enabled: boolean;
  databaseUrl: string | null;
  historyEnabled: boolean;
  historyPolicies: Readonly<Record<string, MeasurementHistoryPolicy>>;
  rollupIntervalMs: number;
  maxPendingWrites: number;
  spoolDirectory: string | null;
  replayIntervalMs: number;
}

export interface MeasurementHistoryPolicy {
  meaningfulChange: number;
  maxHeartbeatMs: number;
}

const defaultHistoryPolicies: Readonly<Record<string, MeasurementHistoryPolicy>> = {
  temperature: { meaningfulChange: 0.3, maxHeartbeatMs: 15 * 60_000 },
  humidity: { meaningfulChange: 2, maxHeartbeatMs: 15 * 60_000 },
  pressure: { meaningfulChange: 1, maxHeartbeatMs: 15 * 60_000 },
  power: { meaningfulChange: 5, maxHeartbeatMs: 5 * 60_000 },
};

function historyPolicies(value: string | undefined): Readonly<Record<string, MeasurementHistoryPolicy>> {
  if (!value?.trim()) return defaultHistoryPolicies;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Invalid TELEMETRY_HISTORY_POLICIES_JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid TELEMETRY_HISTORY_POLICIES_JSON');
  }
  const policies = { ...defaultHistoryPolicies } as Record<string, MeasurementHistoryPolicy>;
  for (const [metric, raw] of Object.entries(parsed)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(metric) || !raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Invalid TELEMETRY_HISTORY_POLICIES_JSON');
    }
    const policy = raw as Record<string, unknown>;
    if (Object.keys(policy).some(key => key !== 'meaningfulChange' && key !== 'maxHeartbeatMs') ||
        typeof policy.meaningfulChange !== 'number' || !Number.isFinite(policy.meaningfulChange) || policy.meaningfulChange <= 0 ||
        !Number.isSafeInteger(policy.maxHeartbeatMs) || (policy.maxHeartbeatMs as number) < 1000 || (policy.maxHeartbeatMs as number) > 31_536_000_000) {
      throw new Error(`Invalid history policy for ${metric}`);
    }
    policies[metric] = { meaningfulChange: policy.meaningfulChange, maxHeartbeatMs: policy.maxHeartbeatMs as number };
  }
  return policies;
}

export function telemetryConfig(env: NodeJS.ProcessEnv): TelemetryConfig {
  const enabled = env.TELEMETRY_ENABLED === 'true';
  const historyEnabled = env.TELEMETRY_HISTORY_ENABLED === 'true';
  const databaseUrl = env.TELEMETRY_DATABASE_URL?.trim() || null;
  if (enabled && !databaseUrl)
    throw new Error(
      'TELEMETRY_DATABASE_URL is required when telemetry is enabled',
    );
  if (historyEnabled && !databaseUrl) {
    throw new Error('TELEMETRY_DATABASE_URL is required when measurement history is enabled');
  }
  const spoolDirectory = env.TELEMETRY_SPOOL_DIRECTORY?.trim() || null;
  if (enabled && (!spoolDirectory || !isAbsolute(spoolDirectory)))
    throw new Error(
      'An absolute TELEMETRY_SPOOL_DIRECTORY is required when telemetry is enabled',
    );
  const integer = (
    name: string,
    fallback: number,
    min: number,
    max: number,
  ) => {
    const n = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isInteger(n) || n < min || n > max)
      throw new Error(`Invalid ${name}`);
    return n;
  };
  return {
    enabled,
    databaseUrl,
    historyEnabled,
    historyPolicies: historyPolicies(env.TELEMETRY_HISTORY_POLICIES_JSON),
    rollupIntervalMs: integer(
      'TELEMETRY_ROLLUP_INTERVAL_MS',
      300_000,
      1000,
      3_600_000,
    ),
    maxPendingWrites: integer(
      'TELEMETRY_MAX_PENDING_WRITES',
      100_000,
      1,
      1_000_000,
    ),
    spoolDirectory,
    replayIntervalMs: integer(
      'TELEMETRY_REPLAY_INTERVAL_MS',
      5000,
      1000,
      60_000,
    ),
  };
}
