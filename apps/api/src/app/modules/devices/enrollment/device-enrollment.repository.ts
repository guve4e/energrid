import type {
  DeviceEnrollment,
  DeviceEnrollmentEvent,
  DeviceEnrollmentIdentity,
  DeviceEnrollmentScope,
} from '@energrid/domain-devices';

/**
 * Persistence port for explicit device enrollment.
 *
 * Implementations may use PostgreSQL, SQLite,
 * or another durable storage engine.
 */
export interface DeviceEnrollmentRepository {
  find(
    identity: DeviceEnrollmentIdentity,
  ): Promise<DeviceEnrollment | null>;

  list(
    scope: DeviceEnrollmentScope,
  ): Promise<DeviceEnrollment[]>;

  /**
   * Atomically persist the enrollment transition
   * and its corresponding audit event.
   *
   * Implementations must reject conflicting enrollment
   * writes rather than silently overwrite them.
   */
  commit(
    enrollment: DeviceEnrollment,
    event: DeviceEnrollmentEvent,
  ): Promise<void>;
}
