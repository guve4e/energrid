import type { RegisteredDevice } from '../devices/device-registry.types';
import type { IntelligenceObservationResult } from '../devices/device-intelligence-observation';

/**
 * Restore approved durable observations into the Devices summary after an API
 * restart. This is a display projection only: it never asserts connectivity.
 */
export function projectDeviceSummaryObservation(
  device: RegisteredDevice,
  observation: IntelligenceObservationResult | null,
): RegisteredDevice {
  if (!observation || observation.deviceId !== device.id) return device;

  const entries = Object.entries(observation.fields).filter(([, field]) => {
    const timestamp = Date.parse(field.measuredAt || field.receivedAt);
    return field.authority === 'approved' && Number.isFinite(timestamp) &&
      timestamp <= Date.now() &&
      (typeof field.value === 'number' || typeof field.value === 'boolean' || typeof field.value === 'string');
  });
  if (!entries.length) return device;

  const values = Object.fromEntries(entries.map(([name, field]) => [name, field.value]));
  const observedAt = entries
    .map(([, field]) => field.measuredAt || field.receivedAt)
    .reduce((latest, current) => Date.parse(current) > Date.parse(latest) ? current : latest);

  return {
    ...device,
    state: {
      ...device.state,
      values: { ...device.state.values, ...values },
      observedAt,
      source: 'approved-observation',
      // Keep the registry connectivity state unchanged. A historical reading
      // is not evidence that the observer can reach the device now.
    },
  };
}
