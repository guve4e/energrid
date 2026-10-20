import {
  createDeviceEnrollment,
  changeDeviceEnrollmentStatus,
  type DeviceEnrollment,
  type DeviceEnrollmentEvent,
  type DeviceEnrollmentIdentity,
  type DeviceEnrollmentScope,
} from '@energrid/domain-devices';

import type {
  DeviceEnrollmentRepository,
} from './device-enrollment.repository';

const identity = {
  tenantId: 'tenant-demo',
  siteId: 'site-home',
  deviceId: 'temp-kitchen',
};

const firstTime = '2026-10-19T08:00:00.000Z';
const secondTime = '2026-10-19T08:01:00.000Z';

describe('Device Enrollment Domain', () => {
  it('creates an explicit enrollment', () => {
    const enrollment = createDeviceEnrollment(
      {
        ...identity,
        displayName: 'Kitchen Temperature',
      },
      firstTime,
    );

    expect(enrollment).toMatchObject({
      ...identity,
      schemaVersion: 1,
      status: 'enrolled',
      displayName: 'Kitchen Temperature',
      enrolledAt: firstTime,
    });

    // Enrollment is not observation or command approval.
    expect('trustStatus' in enrollment).toBe(false);
    expect('control' in enrollment).toBe(false);
  });

  it('rejects incomplete device identities', () => {
    expect(() =>
      createDeviceEnrollment(
        {
          ...identity,
          deviceId: '  ',
          displayName: 'Kitchen Temperature',
        },
        firstTime,
      ),
    ).toThrow('deviceId is required');
  });

  it('supports suspension and reactivation', () => {
    const enrolled = createDeviceEnrollment(
      {
        ...identity,
        displayName: 'Kitchen Temperature',
      },
      firstTime,
    );

    const suspended = changeDeviceEnrollmentStatus(
      enrolled,
      'suspended',
      secondTime,
    );

    expect(suspended.status).toBe('suspended');
    expect(enrolled.status).toBe('enrolled');

    const reactivated = changeDeviceEnrollmentStatus(
      suspended,
      'enrolled',
      '2026-10-19T08:02:00.000Z',
    );

    expect(reactivated.status).toBe('enrolled');
    expect(reactivated.enrolledAt).toBe(firstTime);
  });

  it('retires an enrollment irreversibly until explicit reenrollment', () => {
    const enrolled = createDeviceEnrollment(
      { ...identity, displayName: 'Kitchen Temperature' },
      firstTime,
    );

    const retired = changeDeviceEnrollmentStatus(
      enrolled,
      'retired',
      secondTime,
    );

    expect(retired.status).toBe('retired');
    expect(enrolled.status).toBe('enrolled');
    expect(() => changeDeviceEnrollmentStatus(
      retired,
      'enrolled',
      '2026-10-19T08:02:00.000Z',
    )).toThrow(/retired/i);
  });

  it('rejects out-of-order transitions', () => {
    const enrolled = createDeviceEnrollment(
      {
        ...identity,
        displayName: 'Kitchen Temperature',
      },
      secondTime,
    );

    expect(() =>
      changeDeviceEnrollmentStatus(
        enrolled,
        'suspended',
        firstTime,
      ),
    ).toThrow('out of order');
  });
});

/**
 * Test-only adapter.
 * Demonstrates that the application contract works
 * without PostgreSQL, MQTT, or any external dependency.
 */
class FakeEnrollmentRepository
  implements DeviceEnrollmentRepository {
  private readonly records = new Map<string, DeviceEnrollment>();

  readonly events: DeviceEnrollmentEvent[] = [];

  private key(identity: DeviceEnrollmentIdentity): string {
    return JSON.stringify([
      identity.tenantId,
      identity.siteId,
      identity.deviceId,
    ]);
  }

  async find(
    identity: DeviceEnrollmentIdentity,
  ): Promise<DeviceEnrollment | null> {
    return this.records.get(this.key(identity)) ?? null;
  }

  async list(
    scope: DeviceEnrollmentScope,
  ): Promise<DeviceEnrollment[]> {
    return [...this.records.values()].filter(
      (record) =>
        record.tenantId === scope.tenantId &&
        record.siteId === scope.siteId,
    );
  }

  async commit(
    enrollment: DeviceEnrollment,
    event: DeviceEnrollmentEvent,
  ): Promise<void> {
    if (
      enrollment.tenantId !== event.tenantId ||
      enrollment.siteId !== event.siteId ||
      enrollment.deviceId !== event.deviceId
    ) {
      throw new Error('Enrollment event identity mismatch');
    }

    // Test-only storage; the production adapter must enforce
    // transactional and concurrency guarantees.
    this.records.set(this.key(enrollment), enrollment);
    this.events.push(event);
  }
}

describe('Device Enrollment Repository Contract', () => {
  it('supports scope-isolated enrollment storage', async () => {
    const repository = new FakeEnrollmentRepository();

    const enrollment = createDeviceEnrollment(
      {
        ...identity,
        displayName: 'Kitchen Temperature',
      },
      firstTime,
    );

    await repository.commit(enrollment, {
      ...identity,
      eventId: 'test-event-1',
      action: 'enrolled',
      actor: 'test-operator',
      occurredAt: firstTime,
    });

    expect(await repository.find(identity)).toEqual(enrollment);

    expect(
      await repository.list({
        tenantId: identity.tenantId,
        siteId: identity.siteId,
      }),
    ).toHaveLength(1);

    expect(
      await repository.list({
        tenantId: identity.tenantId,
        siteId: 'another-site',
      }),
    ).toHaveLength(0);

    expect(repository.events).toHaveLength(1);
  });
});
