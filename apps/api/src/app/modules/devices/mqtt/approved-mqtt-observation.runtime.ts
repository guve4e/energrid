import {
  Injectable,
  OnModuleDestroy,
} from '@nestjs/common';

import { DeviceRegistryService } from '../device-registry.service';
import { DeviceInstallationStore } from '../device-installation.store';
import { DeviceObservationStateStore } from '../device-observation-state.store';

import {
  ApprovedMqttObservationRoute,
  type ApprovedMqttObservationConfig,
} from './approved-mqtt-observation.route';
import { Inject } from '@nestjs/common';
import { DEVICE_ENROLLMENT_SERVICE } from '../enrollment/device-enrollment.module';
import type { DeviceEnrollmentService } from '../enrollment/device-enrollment.service';
import type { DeviceObservationState } from '@energrid/domain-devices';

/**
 * Runtime owner of explicitly configured MQTT observation profiles.
 *
 * Disabled by default.
 *
 * No device is created, discovered, or approved by this service.
 */
@Injectable()
export class ApprovedMqttObservationRuntime
  implements OnModuleDestroy
{
  readonly route?: ApprovedMqttObservationRoute;

  private readonly store?: DeviceObservationStateStore;
  private readonly configs: ApprovedMqttObservationConfig[] = [];

  constructor(
    private readonly registry: DeviceRegistryService,
    private readonly installations: DeviceInstallationStore,
    @Inject(DEVICE_ENROLLMENT_SERVICE)
    private readonly enrollment: DeviceEnrollmentService,
  ) {
    const raw = process.env.HOME_OBSERVATION_BINDINGS_JSON?.trim();

    if (!raw) {
      return;
    }

    const directory =
      process.env.HOME_OBSERVATION_STORE_DIRECTORY?.trim();

    if (!directory) {
      throw new Error(
        'HOME_OBSERVATION_STORE_DIRECTORY is required when ' +
        'MQTT observation profiles are enabled',
      );
    }

    const parsed: unknown = JSON.parse(raw);

    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error(
        'HOME_OBSERVATION_BINDINGS_JSON must be a nonempty array',
      );
    }

    const configs = parsed as ApprovedMqttObservationConfig[];
    this.configs.push(...configs);

    this.store = new DeviceObservationStateStore(directory);

    this.route = new ApprovedMqttObservationRoute(
      registry,
      this.store,
      configs,
      installations,
      enrollment,
    );
  }

  async recover(): Promise<void> {
    if (!this.route) return;

    await this.registry.ensureInstallationsLoaded();
    await this.route.recover();
  }

  /** Read only persisted fields covered by an active, approved MQTT binding. */
  async getAuthorizedObservation(scope: { tenantId: string; siteId: string }, deviceId: string): Promise<DeviceObservationState | null> {
    const config = this.configs.find(item => item.binding.deviceId === deviceId &&
      item.scope.tenantId === scope.tenantId && item.scope.siteId === scope.siteId);
    if (!config || !this.store) return null;
    const device = this.registry.getDevices().find(item =>
      item.id === deviceId && item.tenantId === scope.tenantId &&
      item.siteId === scope.siteId && item.kind === 'physical' &&
      item.trustStatus === 'approved');
    if (!device) return null;
    if (this.enrollment) {
      const enrollment = await this.enrollment.find({ ...scope, deviceId });
      if (!enrollment || enrollment.status !== 'enrolled') return null;
    }
    const installation = await this.installations.get(scope.siteId, deviceId);
    if (!installation || installation.schemaVersion !== 1 ||
      installation.device.id !== deviceId || installation.device.tenantId !== scope.tenantId ||
      installation.device.siteId !== scope.siteId || installation.device.trustStatus !== 'approved') return null;

    const state = await this.store.getState(scope, deviceId);
    if (!state) return null;
    const allowedFields = Object.keys(config.binding.fields).filter(field =>
      config.policy.allowedSourcesByField?.[field]?.includes(config.binding.sourceId));
    const fields = Object.fromEntries(Object.entries(state.fields).filter(([field, observation]) =>
      allowedFields.includes(field) && observation.sourceId === config.binding.sourceId));
    return Object.keys(fields).length ? { ...state, fields } : null;
  }

  async onModuleDestroy(): Promise<void> {
    await this.store?.close();
  }
}
