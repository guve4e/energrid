import type {
  ApprovedObservationBinding,
  ObservationAuthorityPolicy,
} from '@energrid/domain-devices';
import type {
  DeviceInstallationRecord,
} from './device-installation.store';

export interface ResolvedObservationAuthority {
  binding: ApprovedObservationBinding;
  policy: ObservationAuthorityPolicy;
}

/**
 * Resolve field authority only from a persisted approved installation.
 *
 * Incoming protocol payloads may never supply their own binding
 * or authority policy.
 *
 * Enrollment and tenant/site authorization must also be checked
 * by Core before invoking this resolver.
 */
export function resolveInstallationObservationAuthority(
  installation: DeviceInstallationRecord | null,
  sourceId: string,
  selector: string,
): ResolvedObservationAuthority | null {
  if (
    !installation ||
    installation.schemaVersion !== 1 ||
    installation.device.trustStatus !== 'approved'
  ) return null;

  const config = installation.observationAuthority;

  if (
    !config ||
    !Array.isArray(config.bindings) ||
    config.policy?.deviceId !== installation.device.id
  ) return null;

  const matching = config.bindings.filter(binding =>
    binding?.deviceId === installation.device.id &&
    binding.sourceId === sourceId &&
    binding.selector === selector
  );

  // Ambiguous authority configuration must fail closed.
  if (matching.length !== 1) return null;

  const binding = matching[0];

  if (
    !binding.fields ||
    typeof binding.fields !== 'object' ||
    Array.isArray(binding.fields)
  ) return null;

  const allowed = Object.entries(binding.fields).filter(
    ([field, mapping]) =>
      field !== '__proto__' &&
      field !== 'constructor' &&
      field !== 'prototype' &&
      !!mapping &&
      typeof mapping.rawKey === 'string' &&
      mapping.rawKey.trim().length > 0 &&
      ['number', 'boolean', 'string'].includes(mapping.type) &&
      Array.isArray(config.policy.allowedSourcesByField?.[field]) &&
      config.policy.allowedSourcesByField[field].includes(sourceId)
  );

  if (!allowed.length) return null;

  return {
    binding: {
      ...binding,
      fields: Object.fromEntries(allowed),
    },
    policy: config.policy,
  };
}
