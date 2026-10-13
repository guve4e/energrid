import { isAbsolute } from 'node:path';

export const TELEMETRY_POOL = Symbol('TELEMETRY_POOL');
export const TELEMETRY_CONFIG = Symbol('TELEMETRY_CONFIG');
export const TELEMETRY_SPOOL_FACTORY = Symbol('TELEMETRY_SPOOL_FACTORY');

export interface TelemetryConfig {
  enabled: boolean;
  databaseUrl: string | null;
  rollupIntervalMs: number;
  maxPendingWrites: number;
  spoolDirectory: string | null;
  replayIntervalMs: number;
}

export function telemetryConfig(env: NodeJS.ProcessEnv): TelemetryConfig {
  const enabled = env.TELEMETRY_ENABLED === 'true';
  const databaseUrl = env.TELEMETRY_DATABASE_URL?.trim() || null;
  if (enabled && !databaseUrl)
    throw new Error(
      'TELEMETRY_DATABASE_URL is required when telemetry is enabled',
    );
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
