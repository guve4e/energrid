import type { PowerObservation } from '@energrid/domain-telemetry';

/** The legacy document shape is confined to this adapter boundary. */
export interface LegacyPowerDocument {
  timestamp?: unknown;
  value?: unknown;
  unit?: unknown;
}

export function normalizeLegacyPower(
  document: LegacyPowerDocument,
): PowerObservation | null {
  if (
    !(document.timestamp instanceof Date) ||
    !Number.isFinite(document.timestamp.getTime())
  )
    return null;
  const raw =
    document.value && typeof document.value === 'object'
      ? (document.value as { value?: unknown }).value
      : document.value;
  const numeric =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' &&
          /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(raw.trim())
        ? Number(raw)
        : NaN;
  const multiplier =
    document.unit == null || document.unit === 'W'
      ? 1
      : document.unit === 'kW'
        ? 1000
        : NaN;
  const powerW = numeric * multiplier;
  // Retain invalid values as continuity breaks. Dropping them would bridge missing observations.
  return {
    observedAt: document.timestamp.toISOString(),
    powerW: Number.isFinite(powerW) && powerW >= 0 ? powerW : null,
  };
}
