import type { GenericMeasurement } from '@energrid/domain-telemetry';
import type { MeasurementHistoryPolicy } from '../telemetry.config';

export type MeasurementHistoryDecision =
  | { persist: true; reason: 'initial' | 'meaningful_change' | 'heartbeat' }
  | { persist: false; reason: 'below_threshold' | 'clock_not_advanced' };

/** Decide against the last committed PostgreSQL row so the decision survives API restarts. */
export function decideMeasurementHistoryWrite(
  current: GenericMeasurement,
  previous: GenericMeasurement | null,
  policy: MeasurementHistoryPolicy,
): MeasurementHistoryDecision {
  if (!Number.isFinite(policy.meaningfulChange) || policy.meaningfulChange <= 0 ||
      !Number.isSafeInteger(policy.maxHeartbeatMs) || policy.maxHeartbeatMs < 1000) {
    throw new Error('Invalid measurement history policy');
  }
  if (current.quality !== 'measured' || typeof current.value !== 'number' || !Number.isFinite(current.value)) {
    throw new Error('History writer accepts only measured numeric observations');
  }
  if (!previous) return { persist: true, reason: 'initial' };
  if (previous.quality !== 'measured' || typeof previous.value !== 'number') {
    return { persist: true, reason: 'meaningful_change' };
  }
  if (Math.abs(current.value - previous.value) >= policy.meaningfulChange) {
    return { persist: true, reason: 'meaningful_change' };
  }
  const elapsedMs = Date.parse(current.receivedAt) - Date.parse(previous.receivedAt);
  if (elapsedMs < 0) return { persist: false, reason: 'clock_not_advanced' };
  if (elapsedMs >= policy.maxHeartbeatMs) return { persist: true, reason: 'heartbeat' };
  return { persist: false, reason: 'below_threshold' };
}
