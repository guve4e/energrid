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

  constructor(
    private readonly registry: DeviceRegistryService,
    installations: DeviceInstallationStore,
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

    this.store = new DeviceObservationStateStore(directory);

    this.route = new ApprovedMqttObservationRoute(
      registry,
      this.store,
      configs,
      installations,
    );
  }

  async recover(): Promise<void> {
    if (!this.route) return;

    await this.registry.ensureInstallationsLoaded();
    await this.route.recover();
  }

  async onModuleDestroy(): Promise<void> {
    await this.store?.close();
  }
}
