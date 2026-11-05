import type { GenericMeasurement } from '@energrid/domain-telemetry';

export const DEFAULT_MAX_POWER_INTEGRATION_INTERVAL_MS = 5 * 60_000;

export type EnergyEstimateGapReason =
  | 'boundary'
  | 'maximum_interval_exceeded'
  | 'invalid_sample'
  | 'conflicting_duplicate_timestamp';

export interface PowerEnergyEstimate {
  status: 'estimated' | 'partial_estimate' | 'insufficient_coverage';
  method: 'trapezoidal';
  /** Signed net energy over covered intervals only. Null when no interval is covered. */
  signedEnergyKwh: number | null;
  requestedDurationSeconds: number;
  coveredDurationSeconds: number;
  coveragePercent: number;
  maximumIntegratedIntervalSeconds: number;
  uncoveredGaps: Array<{
    from: string;
    to: string;
    durationSeconds: number;
    reason: EnergyEstimateGapReason;
  }>;
}

interface PowerPoint {
  at: number;
  value: number | null;
  valid: boolean;
  duplicateConflict: boolean;
}

/**
 * Integrate only adjacent, measured W samples within the configured power-history
 * heartbeat. This cadence comes from the history writer, not the Portal chart.
 */
export function estimatePowerEnergy(
  measurements: readonly Pick<GenericMeasurement, 'observedAt' | 'value' | 'quality' | 'unit'>[],
  from: string,
  to: string,
  maximumIntegratedIntervalMs: number,
): PowerEnergyEstimate {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start ||
      !Number.isSafeInteger(maximumIntegratedIntervalMs) || maximumIntegratedIntervalMs < 1) {
    throw new Error('Invalid power energy estimation interval');
  }

  const requestedMs = end - start;
  const gaps: PowerEnergyEstimate['uncoveredGaps'] = [];
  const addGap = (gapStart: number, gapEnd: number, reason: EnergyEstimateGapReason) => {
    if (gapEnd <= gapStart) return;
    gaps.push({
      from: new Date(gapStart).toISOString(),
      to: new Date(gapEnd).toISOString(),
      durationSeconds: (gapEnd - gapStart) / 1000,
      reason,
    });
  };

  const parsed = measurements.map(row => ({
    at: Date.parse(row.observedAt),
    valid: row.quality === 'measured' && row.unit === 'W' &&
      typeof row.value === 'number' && Number.isFinite(row.value),
    value: typeof row.value === 'number' && Number.isFinite(row.value) ? row.value : null,
    unit: row.unit,
  }));
  // A timestamp we cannot order makes the series unsafe to integrate: fail closed.
  if (parsed.some(point => !Number.isFinite(point.at))) {
    addGap(start, end, 'invalid_sample');
    return result(null, 0, requestedMs, maximumIntegratedIntervalMs, gaps);
  }

  const ordered = parsed
    .filter(point => point.at >= start && point.at <= end)
    .sort((a, b) => a.at - b.at);
  const points: PowerPoint[] = [];
  for (let index = 0; index < ordered.length;) {
    let next = index + 1;
    while (next < ordered.length && ordered[next].at === ordered[index].at) next++;
    const group = ordered.slice(index, next);
    const values = new Set(group.filter(point => point.valid).map(point => point.value));
    const allValid = group.every(point => point.valid);
    const conflicting = values.size > 1 || (allValid && group.some(point => point.unit !== group[0].unit));
    points.push({
      at: group[0].at,
      value: allValid && values.size === 1 ? group[0].value : null,
      valid: allValid && values.size === 1,
      duplicateConflict: conflicting,
    });
    index = next;
  }

  if (!points.length) {
    addGap(start, end, 'boundary');
    return result(null, 0, requestedMs, maximumIntegratedIntervalMs, gaps);
  }

  let coveredMs = 0;
  let energyKwh = 0;
  addGap(start, points[0].at, 'boundary');
  for (let index = 1; index < points.length; index++) {
    const previous = points[index - 1];
    const current = points[index];
    const intervalMs = current.at - previous.at;
    if (previous.valid && current.valid && intervalMs <= maximumIntegratedIntervalMs) {
      // Trapezoidal integration preserves negative power and does not fill gaps.
      energyKwh += ((previous.value! + current.value!) / 2) * intervalMs / 3_600_000_000;
      coveredMs += intervalMs;
    } else {
      const reason: EnergyEstimateGapReason = previous.duplicateConflict || current.duplicateConflict
        ? 'conflicting_duplicate_timestamp'
        : !previous.valid || !current.valid
          ? 'invalid_sample'
          : 'maximum_interval_exceeded';
      addGap(previous.at, current.at, reason);
    }
  }
  addGap(points[points.length - 1].at, end, 'boundary');

  return result(coveredMs ? energyKwh : null, coveredMs, requestedMs, maximumIntegratedIntervalMs, gaps);
}

function result(
  signedEnergyKwh: number | null,
  coveredMs: number,
  requestedMs: number,
  maximumIntegratedIntervalMs: number,
  uncoveredGaps: PowerEnergyEstimate['uncoveredGaps'],
): PowerEnergyEstimate {
  return {
    status: coveredMs === 0 ? 'insufficient_coverage'
      : coveredMs === requestedMs ? 'estimated' : 'partial_estimate',
    method: 'trapezoidal',
    signedEnergyKwh,
    requestedDurationSeconds: requestedMs / 1000,
    coveredDurationSeconds: coveredMs / 1000,
    coveragePercent: coveredMs / requestedMs * 100,
    maximumIntegratedIntervalSeconds: maximumIntegratedIntervalMs / 1000,
    uncoveredGaps,
  };
}
