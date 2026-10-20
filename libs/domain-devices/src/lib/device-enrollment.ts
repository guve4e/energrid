/**
 * Energrid Device Enrollment Domain V1
 *
 * Pure domain logic.
 * No databases, NestJS, MQTT, HTTP, or infrastructure dependencies.
 */

export interface DeviceEnrollmentScope {
  tenantId: string;
  siteId: string;
}

export interface DeviceEnrollmentIdentity
  extends DeviceEnrollmentScope {
  deviceId: string;
}

export type DeviceEnrollmentStatus =
  | 'enrolled'
  | 'suspended'
  | 'retired';

export interface DeviceEnrollment
  extends DeviceEnrollmentIdentity {
  schemaVersion: 1;
  version: number;
  displayName: string;
  status: DeviceEnrollmentStatus;
  enrolledAt: string;
  updatedAt: string;
}

export type DeviceEnrollmentAction =
  | 'enrolled'
  | 'suspended'
  | 'reactivated'
  | 'retired'
  | 'reenrolled';

export interface DeviceEnrollmentEvent
  extends DeviceEnrollmentIdentity {
  eventId: string;
  action: DeviceEnrollmentAction;
  actor: string;
  occurredAt: string;
}

function requiredText(
  value: string,
  field: string,
): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} is required`);
  }

  return value.trim();
}

function validTimestamp(value: string): string {
  const time = Date.parse(value);

  if (!Number.isFinite(time)) {
    throw new Error('Invalid enrollment timestamp');
  }

  return new Date(time).toISOString();
}

export function createDeviceEnrollment(
  input: DeviceEnrollmentIdentity & {
    displayName: string;
  },
  occurredAt: string,
): DeviceEnrollment {
  const now = validTimestamp(occurredAt);

  return {
    schemaVersion: 1,
    version: 1,
    tenantId: requiredText(input.tenantId, 'tenantId'),
    siteId: requiredText(input.siteId, 'siteId'),
    deviceId: requiredText(input.deviceId, 'deviceId'),
    displayName: requiredText(
      input.displayName,
      'displayName',
    ),
    status: 'enrolled',
    enrolledAt: now,
    updatedAt: now,
  };
}

export function changeDeviceEnrollmentStatus(
  current: DeviceEnrollment,
  nextStatus: DeviceEnrollmentStatus,
  occurredAt: string,
): DeviceEnrollment {
  if (
    nextStatus !== 'enrolled' &&
    nextStatus !== 'suspended' &&
    nextStatus !== 'retired'
  ) {
    throw new Error('Invalid enrollment status');
  }

  if (current.status === nextStatus) {
    throw new Error('Device already has this enrollment status');
  }

  if (current.status === 'retired') {
    throw new Error('Retired devices require explicit reenrollment');
  }

  const now = validTimestamp(occurredAt);

  if (Date.parse(now) < Date.parse(current.updatedAt)) {
    throw new Error('Enrollment transition is out of order');
  }

  return {
    ...current,
    version: current.version + 1,
    status: nextStatus,
    updatedAt: now,
  };
}

export function reenrollDevice(
  current: DeviceEnrollment,
  displayName: string,
  occurredAt: string,
): DeviceEnrollment {
  if (current.status !== 'retired') {
    throw new Error('Only retired devices can be reenrolled');
  }

  const now = validTimestamp(occurredAt);
  if (Date.parse(now) < Date.parse(current.updatedAt)) {
    throw new Error('Enrollment transition is out of order');
  }

  return {
    ...current,
    version: current.version + 1,
    displayName: requiredText(displayName, 'displayName'),
    status: 'enrolled',
    enrolledAt: now,
    updatedAt: now,
  };
}
