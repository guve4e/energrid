import { randomUUID } from 'node:crypto';

import {
  changeDeviceEnrollmentStatus,
} from '@energrid/domain-devices';

import { DeviceEnrollmentService } from './device-enrollment.service';
import { PostgresDeviceEnrollmentRepository } from './postgres-device-enrollment.repository';
import { createVerifiedEnrollmentTestPool } from './postgres-integration-test-database';

const testWithDatabase = process.env.ENERGRID_ENROLLMENT_TEST_DATABASE_URL ? it : it.skip;

describe('PostgreSQL Device Enrollment Integration', () => {
  testWithDatabase(
    'persists enrollment, audit, lifecycle and rejects conflicts',
    async () => {
      const pool = await createVerifiedEnrollmentTestPool({
        max: 2,
        connectionTimeoutMillis: 5000,
      });
      const runId = randomUUID();

      const identity = {
        tenantId: 'energrid-integration-test',
        siteId: 'isolated-test-site',
        deviceId: `test-${runId}`,
      };

      let tick = 0;
      let eventNumber = 0;

      const baseTime = Date.parse('2026-10-19T08:00:00.000Z');

      const now = () =>
        new Date(baseTime + tick++ * 1000).toISOString();

      const eventId = () =>
        `test-${runId}-event-${++eventNumber}`;

      const repository =
        new PostgresDeviceEnrollmentRepository(pool);

      const service = new DeviceEnrollmentService(
        repository,
        now,
        eventId,
      );

      try {
        // 1. Create actual PostgreSQL enrollment.
        const enrolled = await service.enroll(
          {
            ...identity,
            displayName: 'Integration Test Sensor',
          },
          'integration-test',
        );

        expect(enrolled.version).toBe(1);
        expect(enrolled.status).toBe('enrolled');

        // 2. Verify through an independent database connection.
        const secondPool = await createVerifiedEnrollmentTestPool({
          connectionTimeoutMillis: 5000,
        });

        try {
          const secondRepository =
            new PostgresDeviceEnrollmentRepository(secondPool);

          expect(
            await secondRepository.find(identity),
          ).toEqual(enrolled);
        } finally {
          await secondPool.end();
        }

        // 3. Verify site isolation.
        expect(
          await repository.list({
            tenantId: identity.tenantId,
            siteId: 'another-site',
          }),
        ).toHaveLength(0);

        // 4. Suspend device.
        const suspended = await service.suspend(
          identity,
          'integration-test',
        );

        expect(suspended.version).toBe(2);
        expect(suspended.status).toBe('suspended');

        // 5. Reject a stale update using version 1.
        const stale = changeDeviceEnrollmentStatus(
          enrolled,
          'suspended',
          now(),
        );

        await expect(
          repository.commit(stale, {
            ...identity,
            eventId: `test-${runId}-stale`,
            action: 'suspended',
            actor: 'integration-test',
            occurredAt: stale.updatedAt,
          }),
        ).rejects.toThrow('Enrollment concurrency conflict');

        expect(
          await repository.find(identity),
        ).toEqual(suspended);

        // 6. Cause an audit-event conflict after the UPDATE.
        // PostgreSQL must roll back the entire transaction.
        const attempted = changeDeviceEnrollmentStatus(
          suspended,
          'enrolled',
          now(),
        );

        await expect(
          repository.commit(attempted, {
            ...identity,
            // Reuse the suspension event's unique ID.
            eventId: `test-${runId}-event-2`,
            action: 'reactivated',
            actor: 'integration-test',
            occurredAt: attempted.updatedAt,
          }),
        ).rejects.toThrow();

        // Rollback must preserve the previous version and status.
        expect(
          await repository.find(identity),
        ).toEqual(suspended);

        // 7. A legitimate reactivation still succeeds.
        const reactivated = await service.reactivate(
          identity,
          'integration-test',
        );

        expect(reactivated.version).toBe(3);
        expect(reactivated.status).toBe('enrolled');

        const retired = await service.retire(identity, 'integration-test');
        expect(retired.version).toBe(4);
        expect(retired.status).toBe('retired');

        const reenrollmentAttempts = await Promise.allSettled([
          service.reenroll(identity, 'Integration Test Sensor', 'integration-test'),
          service.reenroll(identity, 'Integration Test Sensor', 'integration-test'),
        ]);
        expect(reenrollmentAttempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
        expect(reenrollmentAttempts.filter(result => result.status === 'rejected')).toHaveLength(1);
        const reenrolled = await repository.find(identity);
        expect(reenrolled).not.toBeNull();
        expect(reenrolled!.version).toBe(5);
        expect(reenrolled!.status).toBe('enrolled');

        // A fresh repository connection sees the committed reenrollment.
        const restartedPool = await createVerifiedEnrollmentTestPool({
          connectionTimeoutMillis: 5000,
        });
        try {
          const restartedRepository = new PostgresDeviceEnrollmentRepository(restartedPool);
          expect(await restartedRepository.find(identity)).toEqual(reenrolled);
        } finally {
          await restartedPool.end();
        }

        // 8. Every transition remains in the durable audit history.
        const audit = await pool.query<{ total: number }>(
          `
          SELECT count(*)::int AS total
          FROM device_inventory.enrollment_events
          WHERE tenant_id = $1
            AND site_id = $2
            AND device_id = $3
          `,
          [
            identity.tenantId,
            identity.siteId,
            identity.deviceId,
          ],
        );

        expect(audit.rows[0].total).toBe(5);
      } finally {
        // Clean up ONLY the unique integration-test device.
        try {
          await pool.query(
            `
            DELETE FROM device_inventory.enrollment_events
            WHERE tenant_id = $1
              AND site_id = $2
              AND device_id = $3
            `,
            [
              identity.tenantId,
              identity.siteId,
              identity.deviceId,
            ],
          );

          await pool.query(
            `
            DELETE FROM device_inventory.enrollments
            WHERE tenant_id = $1
              AND site_id = $2
              AND device_id = $3
            `,
            [
              identity.tenantId,
              identity.siteId,
              identity.deviceId,
            ],
          );
        } finally {
          await pool.end();
        }
      }
    },
    30_000,
  );
});
