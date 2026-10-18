import type {
  IncomingDeviceObservation,
  ObservationValue,
} from './device-observation-engine';

/**
 * A declarative mapping from raw payload fields
 * into normalized Energrid observation fields.
 *
 * This profile must come from an approved installation.
 */
export interface ObservationFieldMapping {
  rawKey: string;
  type: 'number' | 'boolean' | 'string';
}

export interface ApprovedObservationBinding {
  deviceId: string;
  sourceId: string;
  selector: string;
  fields: Record<string, ObservationFieldMapping>;
}

export interface ObservationIngressContext {
  selector: string;
  receivedAt: string;
  evidenceId?: string;
}

export type DecodeRejectionReason =
  | 'selector_mismatch'
  | 'invalid_binding'
  | 'invalid_payload'
  | 'no_valid_measurements';

export interface DecodeResult {
  accepted: boolean;
  reason: 'decoded' | DecodeRejectionReason;
  observation: IncomingDeviceObservation | null;
  rejectedFields: string[];
}

function rejected(
  reason: DecodeRejectionReason,
  fields: string[] = [],
): DecodeResult {
  return {
    accepted: false,
    reason,
    observation: null,
    rejectedFields: fields,
  };
}

const forbiddenKeys = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

function validKey(key: string): boolean {
  return key.trim().length > 0 && !forbiddenKeys.has(key);
}

function validBinding(
  binding: ApprovedObservationBinding,
): boolean {
  if (
    !binding ||
    typeof binding.deviceId !== 'string' ||
    !binding.deviceId.trim() ||
    typeof binding.sourceId !== 'string' ||
    !binding.sourceId.trim() ||
    typeof binding.selector !== 'string' ||
    !binding.selector.trim() ||
    !binding.fields ||
    typeof binding.fields !== 'object' ||
    Array.isArray(binding.fields)
  ) {
    return false;
  }

  const entries = Object.entries(binding.fields);

  return entries.length > 0 && entries.every(([key, mapping]) =>
    validKey(key) &&
    mapping != null &&
    typeof mapping === 'object' &&
    typeof mapping.rawKey === 'string' &&
    validKey(mapping.rawKey) &&
    ['number', 'boolean', 'string'].includes(mapping.type)
  );
}

function decodeValue(
  value: unknown,
  type: ObservationFieldMapping['type'],
): ObservationValue | undefined {
  if (type === 'number') {
    return typeof value === 'number' && Number.isFinite(value)
      ? value
      : undefined;
  }

  if (type === 'boolean') {
    return typeof value === 'boolean'
      ? value
      : undefined;
  }

  return typeof value === 'string'
    ? value
    : undefined;
}

/**
 * Converts evidence into a normalized observation.
 *
 * Does not validate approval itself: the caller must
 * retrieve the binding from trusted installation state.
 *
 * Payload-provided device IDs, source IDs and timestamps
 * are deliberately ignored.
 */
export function decodeObservationProfile(
  binding: ApprovedObservationBinding,
  context: ObservationIngressContext,
  payload: unknown,
): DecodeResult {
  if (!validBinding(binding)) {
    return rejected('invalid_binding');
  }

  if (context.selector !== binding.selector) {
    return rejected('selector_mismatch');
  }

  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload)
  ) {
    return rejected('invalid_payload');
  }

  const raw = payload as Record<string, unknown>;
  const values: Record<string, ObservationValue> =
    Object.create(null);

  const rejectedFields: string[] = [];

  for (const [field, mapping] of Object.entries(binding.fields)) {
    const rawValue = Object.prototype.hasOwnProperty.call(
      raw,
      mapping.rawKey,
    )
      ? raw[mapping.rawKey]
      : undefined;

    const value = decodeValue(rawValue, mapping.type);

    if (value === undefined) {
      rejectedFields.push(field);
      continue;
    }

    values[field] = value;
  }

  if (Object.keys(values).length === 0) {
    return rejected('no_valid_measurements', rejectedFields);
  }

  return {
    accepted: true,
    reason: 'decoded',
    rejectedFields,
    observation: {
      deviceId: binding.deviceId,
      sourceId: binding.sourceId,
      evidenceId: context.evidenceId,
      receivedAt: context.receivedAt,
      values,
    },
  };
}
