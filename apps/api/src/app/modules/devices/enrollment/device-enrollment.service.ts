import { randomUUID } from 'node:crypto';

import {
  changeDeviceEnrollmentStatus,
  createDeviceEnrollment,
  reenrollDevice,
  type DeviceEnrollment,
  type DeviceEnrollmentAction,
  type DeviceEnrollmentIdentity,
  type DeviceEnrollmentScope,
  type DeviceEnrollmentStatus,
} from '@energrid/domain-devices';

import type {
  DeviceEnrollmentRepository,
} from './device-enrollment.repository';

type EnrollmentRequest = DeviceEnrollmentIdentity & {
  displayName: string;
};

/**
 * Application use cases for explicit device enrollment.
 *
 * No NestJS, SQL, MQTT, HTTP, or device-control dependencies.
 */
export class DeviceEnrollmentService {
  constructor(
    private readonly repository: DeviceEnrollmentRepository,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly newId: () => string = randomUUID,
  ) {}

  async enroll(
    request: EnrollmentRequest,
    actor: string,
  ): Promise<DeviceEnrollment> {
    this.requireActor(actor);

    const enrollment = createDeviceEnrollment(
      request,
      this.now(),
    );

    const existing = await this.repository.find(enrollment);

    if (existing) {
      throw new Error('Device already enrolled');
    }

    await this.commit(enrollment, 'enrolled', actor);

    return enrollment;
  }

  async suspend(
    identity: DeviceEnrollmentIdentity,
    actor: string,
  ): Promise<DeviceEnrollment> {
    return this.changeStatus(
      identity,
      'suspended',
      'suspended',
      actor,
    );
  }

  async reactivate(
    identity: DeviceEnrollmentIdentity,
    actor: string,
  ): Promise<DeviceEnrollment> {
    return this.changeStatus(
      identity,
      'enrolled',
      'reactivated',
      actor,
    );
  }

  async retire(
    identity: DeviceEnrollmentIdentity,
    actor: string,
  ): Promise<DeviceEnrollment> {
    return this.changeStatus(identity, 'retired', 'retired', actor);
  }

  async reenroll(
    identity: DeviceEnrollmentIdentity,
    displayName: string,
    actor: string,
  ): Promise<DeviceEnrollment> {
    this.requireActor(actor);
    const current = await this.repository.find(identity);
    if (!current) throw new Error('Device enrollment not found');
    const updated = reenrollDevice(current, displayName, this.now());
    await this.commit(updated, 'reenrolled', actor);
    return updated;
  }

  find(identity: DeviceEnrollmentIdentity) {
    return this.repository.find(identity);
  }

  list(scope: DeviceEnrollmentScope) {
    return this.repository.list(scope);
  }

  private async changeStatus(
    identity: DeviceEnrollmentIdentity,
    status: DeviceEnrollmentStatus,
    action: DeviceEnrollmentAction,
    actor: string,
  ): Promise<DeviceEnrollment> {
    this.requireActor(actor);

    const current = await this.repository.find(identity);

    if (!current) {
      throw new Error('Device enrollment not found');
    }

    const updated = changeDeviceEnrollmentStatus(
      current,
      status,
      this.now(),
    );

    await this.commit(updated, action, actor);

    return updated;
  }

  private async commit(
    enrollment: DeviceEnrollment,
    action: DeviceEnrollmentAction,
    actor: string,
  ): Promise<void> {
    await this.repository.commit(enrollment, {
      tenantId: enrollment.tenantId,
      siteId: enrollment.siteId,
      deviceId: enrollment.deviceId,
      eventId: this.newId(),
      action,
      actor: actor.trim(),
      occurredAt: enrollment.updatedAt,
    });
  }

  private requireActor(actor: string): void {
    if (typeof actor !== 'string' || !actor.trim()) {
      throw new Error('Enrollment actor is required');
    }
  }
}
