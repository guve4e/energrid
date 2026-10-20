import type { Pool } from 'pg';

import type {
  DeviceEnrollment,
  DeviceEnrollmentEvent,
  DeviceEnrollmentIdentity,
  DeviceEnrollmentScope,
} from '@energrid/domain-devices';

import type { DeviceEnrollmentRepository } from './device-enrollment.repository';

type EnrollmentRow = {
  tenant_id: string;
  site_id: string;
  device_id: string;
  display_name: string;
  status: 'enrolled' | 'suspended' | 'retired';
  enrolled_at: Date | string;
  updated_at: Date | string;
  version: string | number;
};

function mapEnrollment(row: EnrollmentRow): DeviceEnrollment {
  const version = Number(row.version);

  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error('Invalid persisted enrollment version');
  }

  return {
    schemaVersion: 1,
    tenantId: row.tenant_id,
    siteId: row.site_id,
    deviceId: row.device_id,
    displayName: row.display_name,
    status: row.status,
    enrolledAt: new Date(row.enrolled_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    version,
  };
}

function validateCommit(
  enrollment: DeviceEnrollment,
  event: DeviceEnrollmentEvent,
): void {
  if (
    enrollment.tenantId !== event.tenantId ||
    enrollment.siteId !== event.siteId ||
    enrollment.deviceId !== event.deviceId
  ) {
    throw new Error('Enrollment event identity mismatch');
  }

  if (
    !event.eventId?.trim() ||
    !event.actor?.trim() ||
    event.occurredAt !== enrollment.updatedAt
  ) {
    throw new Error('Invalid enrollment audit event');
  }

  if (
    !Number.isSafeInteger(enrollment.version) ||
    enrollment.version < 1
  ) {
    throw new Error('Invalid enrollment version');
  }

  const validTransition =
    (event.action === 'enrolled' &&
      enrollment.version === 1 &&
      enrollment.status === 'enrolled' &&
      enrollment.enrolledAt === enrollment.updatedAt) ||
    (event.action === 'suspended' &&
      enrollment.version > 1 &&
      enrollment.status === 'suspended') ||
    (event.action === 'reactivated' &&
      enrollment.version > 1 &&
      enrollment.status === 'enrolled') ||
    (event.action === 'retired' &&
      enrollment.version > 1 &&
      enrollment.status === 'retired') ||
    (event.action === 'reenrolled' &&
      enrollment.version > 1 &&
      enrollment.status === 'enrolled' &&
      enrollment.enrolledAt === enrollment.updatedAt);

  if (!validTransition) {
    throw new Error('Invalid enrollment transition');
  }
}

/**
 * PostgreSQL infrastructure adapter.
 *
 * Owns neither the Pool lifecycle nor domain decisions.
 * A commit atomically writes enrollment state and its audit event.
 */
export class PostgresDeviceEnrollmentRepository
  implements DeviceEnrollmentRepository {
  constructor(private readonly pool: Pool) {}

  async find(
    identity: DeviceEnrollmentIdentity,
  ): Promise<DeviceEnrollment | null> {
    const result = await this.pool.query<EnrollmentRow>(
      `
      SELECT *
      FROM device_inventory.enrollments
      WHERE tenant_id = $1
        AND site_id = $2
        AND device_id = $3
      `,
      [identity.tenantId, identity.siteId, identity.deviceId],
    );

    return result.rows[0]
      ? mapEnrollment(result.rows[0])
      : null;
  }

  async list(
    scope: DeviceEnrollmentScope,
  ): Promise<DeviceEnrollment[]> {
    const result = await this.pool.query<EnrollmentRow>(
      `
      SELECT *
      FROM device_inventory.enrollments
      WHERE tenant_id = $1
        AND site_id = $2
      ORDER BY display_name, device_id
      `,
      [scope.tenantId, scope.siteId],
    );

    return result.rows.map(mapEnrollment);
  }

  async commit(
    enrollment: DeviceEnrollment,
    event: DeviceEnrollmentEvent,
  ): Promise<void> {
    validateCommit(enrollment, event);

    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      if (event.action === 'enrolled') {
        await client.query(
          `
          INSERT INTO device_inventory.enrollments (
            tenant_id,
            site_id,
            device_id,
            display_name,
            status,
            enrolled_at,
            updated_at,
            version
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          `,
          [
            enrollment.tenantId,
            enrollment.siteId,
            enrollment.deviceId,
            enrollment.displayName,
            enrollment.status,
            enrollment.enrolledAt,
            enrollment.updatedAt,
            enrollment.version,
          ],
        );
      } else {
        const expectedPreviousStatuses = {
          suspended: ['enrolled'],
          reactivated: ['suspended'],
          retired: ['enrolled', 'suspended'],
          reenrolled: ['retired'],
        }[event.action];

        const result = await client.query(
          `
          UPDATE device_inventory.enrollments
          SET display_name = $4,
              status = $5,
              enrolled_at = CASE WHEN $9 THEN $6 ELSE enrolled_at END,
              updated_at = $6,
              version = version + 1
          WHERE tenant_id = $1
            AND site_id = $2
            AND device_id = $3
            AND version = $7
            AND status = ANY($8::text[])
          `,
          [
            enrollment.tenantId,
            enrollment.siteId,
            enrollment.deviceId,
            enrollment.displayName,
            enrollment.status,
            enrollment.updatedAt,
            enrollment.version - 1,
            expectedPreviousStatuses,
            event.action === 'reenrolled',
          ],
        );

        if (result.rowCount !== 1) {
          throw new Error('Enrollment concurrency conflict');
        }
      }

      await client.query(
        `
        INSERT INTO device_inventory.enrollment_events (
          event_id,
          tenant_id,
          site_id,
          device_id,
          action,
          actor,
          occurred_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        `,
        [
          event.eventId,
          event.tenantId,
          event.siteId,
          event.deviceId,
          event.action,
          event.actor,
          event.occurredAt,
        ],
      );

      await client.query('COMMIT');
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the original transaction failure.
      }

      throw error;
    } finally {
      client.release();
    }
  }
}
