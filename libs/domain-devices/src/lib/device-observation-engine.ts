/**
 * Energrid Device Observation Engine V1
 *
 * Pure deterministic domain logic.
 *
 * No MQTT, database, NestJS, network, or LLM dependencies.
 *
 * Device identity and source trust must be validated upstream.
 * measuredAt must be a validated wall-clock timestamp.
 */

export type ObservationValue = number | boolean | string;

export interface IncomingDeviceObservation {
  deviceId: string;
  sourceId: string;
  evidenceId?: string;

  // Trusted Energrid ingestion timestamp.
  receivedAt: string;

  // Optional validated device measurement timestamp.
  measuredAt?: string;

  values: Record<string, ObservationValue>;
}

/**
 * Approved upstream configuration.
 *
 * This policy must originate from Energrid's trusted
 * device installation/binding store, never from
 * an incoming device payload.
 */
export interface ObservationAuthorityPolicy {
  deviceId: string;
  allowedSourcesByField: Record<string, readonly string[]>;
}

export interface ObservedField {
  value: ObservationValue;
  sourceId: string;
  evidenceId?: string;
  receivedAt: string;
  measuredAt?: string;
  orderAt: string;
}

export interface DeviceObservationState {
  deviceId: string;
  fields: Record<string, ObservedField>;
}

export type ObservationDecisionReason =
  | 'accepted'
  | 'invalid_observation'
  | 'stale_observation'
  | 'source_not_authorized'
  | 'invalid_policy';

export interface ObservationDecision {
  accepted: boolean;
  reason: ObservationDecisionReason;
  updatedKeys: string[];
  ignoredKeys: string[];
  state: DeviceObservationState | null;
}

function validDate(value: string): boolean {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    Number.isFinite(Date.parse(value))
  );
}

function validValue(value: unknown): value is ObservationValue {
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }

  return typeof value === 'boolean' || typeof value === 'string';
}

function invalid(
  state: DeviceObservationState | null,
): ObservationDecision {
  return {
    accepted: false,
    reason: 'invalid_observation',
    updatedKeys: [],
    ignoredKeys: [],
    state,
  };
}

export function processDeviceObservation(
  current: DeviceObservationState | null,
  observation: IncomingDeviceObservation,
  policy: ObservationAuthorityPolicy,
): ObservationDecision {
  if (
    !policy ||
    policy.deviceId !== observation.deviceId ||
    !policy.allowedSourcesByField ||
    typeof policy.allowedSourcesByField !== 'object' ||
    Array.isArray(policy.allowedSourcesByField)
  ) {
    return {
      accepted: false,
      reason: 'invalid_policy',
      updatedKeys: [],
      ignoredKeys: [],
      state: current,
    };
  }

  if (
    !observation.deviceId?.trim() ||
    !observation.sourceId?.trim() ||
    !validDate(observation.receivedAt) ||
    (observation.measuredAt !== undefined &&
      !validDate(observation.measuredAt)) ||
    (current !== null &&
      current.deviceId !== observation.deviceId)
  ) {
    return invalid(current);
  }

  const receivedTime = Date.parse(observation.receivedAt);

  if (
    observation.measuredAt !== undefined &&
    Date.parse(observation.measuredAt) > receivedTime
  ) {
    return invalid(current);
  }

  if (
    !observation.values ||
    typeof observation.values !== 'object' ||
    Array.isArray(observation.values)
  ) {
    return invalid(current);
  }

  const entries = Object.entries(observation.values);

  if (
    entries.length === 0 ||
    entries.some(
      ([key, value]) =>
        !key.trim() ||
        ['__proto__', 'constructor', 'prototype'].includes(key) ||
        !validValue(value),
    )
  ) {
    return invalid(current);
  }

  const orderAt = observation.measuredAt ?? observation.receivedAt;
  const orderTime = Date.parse(orderAt);

  const fields: Record<string, ObservedField> = {
    ...(current?.fields ?? {}),
  };

  const updatedKeys: string[] = [];
  const ignoredKeys: string[] = [];
  const unauthorizedKeys: string[] = [];

  for (const [key, value] of entries) {
    const allowedSources =
      Object.prototype.hasOwnProperty.call(
        policy.allowedSourcesByField,
        key,
      )
        ? policy.allowedSourcesByField[key]
        : undefined;

    if (
      !Array.isArray(allowedSources) ||
      !allowedSources.includes(observation.sourceId)
    ) {
      unauthorizedKeys.push(key);
      ignoredKeys.push(key);
      continue;
    }

    const previous = fields[key];

    // Equal timestamps are conservatively ignored.
    // V2 will support validated device sequence numbers.
    if (
      previous &&
      orderTime <= Date.parse(previous.orderAt)
    ) {
      ignoredKeys.push(key);
      continue;
    }

    fields[key] = {
      value,
      sourceId: observation.sourceId,
      evidenceId: observation.evidenceId,
      receivedAt: observation.receivedAt,
      measuredAt: observation.measuredAt,
      orderAt,
    };

    updatedKeys.push(key);
  }

  const nextState: DeviceObservationState = {
    deviceId: observation.deviceId,
    fields,
  };

  return {
    accepted: updatedKeys.length > 0,
    reason:
      updatedKeys.length > 0
        ? 'accepted'
        : unauthorizedKeys.length > 0
          ? 'source_not_authorized'
          : 'stale_observation',
    updatedKeys,
    ignoredKeys,
    state: nextState,
  };
}

export function observationFreshness(
  field: ObservedField,
  now: string,
  maxAgeMs: number,
): 'fresh' | 'stale' | 'unknown' {
  if (
    !validDate(now) ||
    !Number.isFinite(maxAgeMs) ||
    maxAgeMs < 0
  ) {
    return 'unknown';
  }

  const age = Date.parse(now) - Date.parse(field.receivedAt);

  if (!Number.isFinite(age) || age < 0) {
    return 'unknown';
  }

  return age <= maxAgeMs ? 'fresh' : 'stale';
}
