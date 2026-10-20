import type {
  DeviceEnrollment,
  DeviceEnrollmentEvent,
  DeviceEnrollmentIdentity,
  DeviceEnrollmentScope,
} from '@energrid/domain-devices';

import type {
  DeviceEnrollmentRepository,
} from './device-enrollment.repository';

import {
  DeviceEnrollmentService,
} from './device-enrollment.service';

class FakeRepository implements DeviceEnrollmentRepository {
  readonly records = new Map<string, DeviceEnrollment>();
  readonly events: DeviceEnrollmentEvent[] = [];

  private key(identity: DeviceEnrollmentIdentity): string {
    return JSON.stringify([
      identity.tenantId,
      identity.siteId,
      identity.deviceId,
    ]);
  }

  async find(identity: DeviceEnrollmentIdentity) {
    return this.records.get(this.key(identity)) ?? null;
  }

  async list(scope: DeviceEnrollmentScope) {
    return [...this.records.values()].filter(
      (record) =>
        record.tenantId === scope.tenantId &&
        record.siteId === scope.siteId,
    );
  }

  async commit(
    enrollment: DeviceEnrollment,
    event: DeviceEnrollmentEvent,
  ) {
    const key = this.key(enrollment);
    const existing = this.records.get(key);

    if (event.action === 'enrolled' && existing) {
      throw new Error('Enrollment conflict');
    }

    if (event.action !== 'enrolled' && !existing) {
      throw new Error('Enrollment missing');
    }
    if (event.action !== 'enrolled' &&
      (existing?.version !== enrollment.version - 1 ||
        (event.action === 'reenrolled' && existing.status !== 'retired'))) {
      throw new Error('Enrollment concurrency conflict');
    }

    this.records.set(key, structuredClone(enrollment));
    this.events.push(structuredClone(event));
  }
}

describe('DeviceEnrollmentService', () => {
  const identity = {
    tenantId: 'tenant-demo',
    siteId: 'site-home',
    deviceId: 'temp-kitchen',
  };

  let repository: FakeRepository;
  let service: DeviceEnrollmentService;
  let tick: number;

  beforeEach(() => {
    repository = new FakeRepository();
    tick = 0;

    service = new DeviceEnrollmentService(
      repository,
      () => new Date(
        Date.UTC(2026, 9, 19, 8, 0, tick++),
      ).toISOString(),
      () => `event-${tick}`,
    );
  });

  it('explicitly enrolls a device', async () => {
    const result = await service.enroll(
      { ...identity, displayName: 'Kitchen Temperature' },
      'test-operator',
    );

    expect(result.status).toBe('enrolled');
    expect(repository.events[0].action).toBe('enrolled');
    expect(repository.events[0].actor).toBe('test-operator');
    expect(await service.find(identity)).toEqual(result);
  });

  it('does not enroll the same device twice', async () => {
    const request = {
      ...identity,
      displayName: 'Kitchen Temperature',
    };

    await service.enroll(request, 'test-operator');

    await expect(
      service.enroll(request, 'test-operator'),
    ).rejects.toThrow('already enrolled');

    expect(repository.events).toHaveLength(1);
  });

  it('supports suspension and reactivation', async () => {
    await service.enroll(
      { ...identity, displayName: 'Kitchen Temperature' },
      'test-operator',
    );

    const suspended = await service.suspend(
      identity,
      'test-operator',
    );

    expect(suspended.status).toBe('suspended');

    const restored = await service.reactivate(
      identity,
      'test-operator',
    );

    expect(restored.status).toBe('enrolled');

    expect(repository.events.map((event) => event.action))
      .toEqual(['enrolled', 'suspended', 'reactivated']);
  });

  it('requires an explicit reenrollment after retirement', async () => {
    await service.enroll(
      { ...identity, displayName: 'Kitchen Temperature' },
      'test-operator',
    );
    const retired = await service.retire(identity, 'test-operator');
    expect(retired.status).toBe('retired');
    await expect(service.reactivate(identity, 'test-operator'))
      .rejects.toThrow(/retired/i);

    const reenrolled = await service.reenroll(
      identity,
      'Kitchen Temperature',
      'test-operator',
    );
    expect(reenrolled.status).toBe('enrolled');
    expect(reenrolled.enrolledAt).toBe(reenrolled.updatedAt);
    expect(repository.events.map(event => event.action)).toEqual([
      'enrolled', 'retired', 'reenrolled',
    ]);
  });

  it('allows only one of two concurrent reenrollment decisions to commit', async () => {
    await service.enroll({ ...identity, displayName: 'Kitchen Temperature' }, 'test-operator');
    await service.retire(identity, 'test-operator');

    const results = await Promise.allSettled([
      service.reenroll(identity, 'Kitchen Temperature', 'test-operator'),
      service.reenroll(identity, 'Kitchen Temperature', 'test-operator'),
    ]);

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(await service.find(identity)).toEqual(expect.objectContaining({ status: 'enrolled', version: 3 }));
    expect(repository.events.map(event => event.action)).toEqual(['enrolled', 'retired', 'reenrolled']);
  });

  it('keeps device lists isolated by site', async () => {
    await service.enroll(
      { ...identity, displayName: 'Kitchen Temperature' },
      'test-operator',
    );

    expect(
      await service.list({
        tenantId: 'tenant-demo',
        siteId: 'site-home',
      }),
    ).toHaveLength(1);

    expect(
      await service.list({
        tenantId: 'tenant-demo',
        siteId: 'other-home',
      }),
    ).toHaveLength(0);
  });

  it('requires an identified actor', async () => {
    await expect(
      service.enroll(
        { ...identity, displayName: 'Kitchen Temperature' },
        '',
      ),
    ).rejects.toThrow('actor is required');

    expect(repository.events).toHaveLength(0);
  });
});
