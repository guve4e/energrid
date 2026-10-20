import {
  snapshotId,
  type DeviceEvidenceSnapshot,
} from './device-evidence';

export interface CapturedMqttSample {
  topic: string;
  payload: Record<string, unknown>;
  evidenceId: string;
}

export interface ObservationProfileProposal {
  schemaVersion: 1;
  deviceId: string;
  snapshotId: string;
  status: 'proposed';
  requiresApproval: true;
  protocol: 'mqtt';
  selector: string;
  fields: Record<
    string,
    {
      rawKey: string;
      type: 'number' | 'boolean' | 'string';
    }
  >;
  supportingEvidenceIds: string[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value);
}

function validKey(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 100 &&
    !['__proto__', 'constructor', 'prototype'].includes(value);
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'string':
      return typeof value === 'string';
    default:
      return false;
  }
}

/**
 * Validate an untrusted AI-generated observation proposal
 * against server-held evidence and captured MQTT samples.
 *
 * Successful validation means "eligible for replay",
 * NOT "approved for installation".
 */
export function validateObservationProfileProposal(
  input: unknown,
  snapshot: DeviceEvidenceSnapshot,
  samples: readonly CapturedMqttSample[],
): ObservationProfileProposal {
  if (!record(input)) {
    throw new Error('Invalid observation profile proposal');
  }

  if (
    input.schemaVersion !== 1 ||
    input.deviceId !== snapshot.deviceId ||
    input.snapshotId !== snapshotId(snapshot) ||
    input.status !== 'proposed' ||
    input.requiresApproval !== true ||
    input.protocol !== 'mqtt'
  ) {
    throw new Error('Proposal identity or approval state invalid');
  }

  if (
    typeof input.selector !== 'string' ||
    input.selector.length < 1 ||
    input.selector.length > 512 ||
    input.selector.includes('+') ||
    input.selector.includes('#') ||
    input.selector.includes('\0')
  ) {
    throw new Error('Invalid MQTT selector');
  }

  if (!record(input.fields)) {
    throw new Error('Invalid proposed field mappings');
  }

  const fields = Object.entries(input.fields);

  if (fields.length === 0 || fields.length > 16) {
    throw new Error('Invalid proposed field count');
  }

  const evidenceById = new Map(
    snapshot.evidence.map((evidence) => [
      evidence.id,
      evidence,
    ]),
  );

  if (
    !Array.isArray(input.supportingEvidenceIds) ||
    input.supportingEvidenceIds.length === 0 ||
    input.supportingEvidenceIds.length > 20 ||
    !input.supportingEvidenceIds.every(
      (id) => typeof id === 'string' && evidenceById.has(id),
    )
  ) {
    throw new Error('Invalid proposal evidence references');
  }

  const supportingIds = new Set(
    input.supportingEvidenceIds as string[],
  );

  // Only directly observed MQTT evidence can support a mapping.
  const supportedSamples = samples.filter((sample) => {
    const evidence = evidenceById.get(sample.evidenceId);

    return (
      sample.topic === input.selector &&
      supportingIds.has(sample.evidenceId) &&
      evidence?.source === 'mqtt' &&
      evidence.confidence === 'observed' &&
      record(sample.payload)
    );
  });

  if (supportedSamples.length === 0) {
    throw new Error('No captured MQTT evidence supports this selector');
  }

  for (const [field, mapping] of fields) {
    if (
      !validKey(field) ||
      !record(mapping) ||
      !validKey(mapping.rawKey) ||
      !['number', 'boolean', 'string'].includes(
        String(mapping.type),
      )
    ) {
      throw new Error(`Invalid mapping: ${field}`);
    }

    const observed = supportedSamples.some((sample) =>
      Object.prototype.hasOwnProperty.call(
        sample.payload,
        mapping.rawKey as string,
      ) &&
      matchesType(
        sample.payload[mapping.rawKey as string],
        mapping.type as string,
      ),
    );

    if (!observed) {
      throw new Error(
        `No matching captured value supports field: ${field}`,
      );
    }
  }

  // Return a fresh, explicitly validated object.
  // Never expose the original untrusted input as a trusted DTO.
  return {
    schemaVersion: 1,
    deviceId: snapshot.deviceId,
    snapshotId: snapshotId(snapshot),
    status: 'proposed',
    requiresApproval: true,
    protocol: 'mqtt',
    selector: input.selector,
    fields: Object.fromEntries(
      fields.map(([field, mapping]) => {
        const value = mapping as Record<string, unknown>;

        return [
          field,
          {
            rawKey: value.rawKey as string,
            type: value.type as 'number' | 'boolean' | 'string',
          },
        ];
      }),
    ),
    supportingEvidenceIds: [...supportingIds],
  };
}
