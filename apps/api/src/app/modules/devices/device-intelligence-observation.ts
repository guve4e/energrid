import type { DeviceObservationState } from '@energrid/domain-devices';

export type ObservationFreshness = 'fresh' | 'stale' | 'invalid';

export interface IntelligenceObservedField {
  value: number | boolean | string;
  sourceId: string;
  evidenceId?: string;
  receivedAt: string;
  measuredAt?: string;
  ageSeconds: number | null;
  freshness: ObservationFreshness;
  authority: 'approved';
}

export interface IntelligenceObservationResult {
  deviceId: string;
  fields: Record<string, IntelligenceObservedField>;
}

export function projectAuthorizedObservations(
  state: DeviceObservationState,
  freshnessLimitSeconds: number,
  now = Date.now(),
): IntelligenceObservationResult {
  if (
    !Number.isFinite(freshnessLimitSeconds) ||
    freshnessLimitSeconds <= 0
  ) {
    throw new Error('Valid freshness limit required');
  }

  const fields: Record<string, IntelligenceObservedField> = {};

  for (const [name, observation] of Object.entries(state.fields)) {
    const received = Date.parse(observation.receivedAt);
    const measured = observation.measuredAt
      ? Date.parse(observation.measuredAt)
      : null;

    const valid =
      Number.isFinite(received) &&
      received <= now &&
      (measured === null ||
        (Number.isFinite(measured) && measured <= now));

    const reference = measured === null
      ? received
      : Math.min(received, measured);

    const ageSeconds = valid
      ? Math.floor((now - reference) / 1000)
      : null;

    fields[name] = {
      value: observation.value,
      sourceId: observation.sourceId,
      ...(observation.evidenceId
        ? { evidenceId: observation.evidenceId }
        : {}),
      receivedAt: observation.receivedAt,
      ...(observation.measuredAt
        ? { measuredAt: observation.measuredAt }
        : {}),
      ageSeconds,
      freshness: ageSeconds === null
        ? 'invalid'
        : ageSeconds <= freshnessLimitSeconds
          ? 'fresh'
          : 'stale',
      authority: 'approved',
    };
  }

  return {
    deviceId: state.deviceId,
    fields,
  };
}
