import { DeviceRegistryService } from '../device-registry.service';
import { DeviceObservationService } from '../device-observation.service';
import { EnergridMqttAdapter } from '../adapters/inbound/energrid-mqtt.adapter';
import { LegacyFrameworkMqttAdapter } from '../adapters/inbound/legacy/legacy-framework-mqtt.adapter';
import { LegacyTemperatureMqttAdapter } from '../adapters/inbound/legacy/legacy-temperature-mqtt.adapter';
import { ShellyMqttAdapter } from '../adapters/inbound/shelly/shelly-mqtt.adapter';
import type { TelemetryIngestService } from '../../telemetry/telemetry-ingest.service';
import type {
  DeviceMqttAdapterResult,
  DeviceMqttMessage,
  DeviceMqttMessageAdapter,
} from './device-mqtt-message-adapter';

export class DeviceMqttMessageRouter {
  private readonly legacyTemperature = new LegacyTemperatureMqttAdapter();

  private readonly legacyFramework = new LegacyFrameworkMqttAdapter();

  private readonly adapters: DeviceMqttMessageAdapter[];

  constructor(
    private readonly registry: DeviceRegistryService,
    private readonly observation: DeviceObservationService,
    private readonly telemetry?: TelemetryIngestService,
  ) {
    this.adapters = [
      this.legacyTemperature,
      new ShellyMqttAdapter(registry),
      this.legacyFramework,
      new EnergridMqttAdapter(),
    ];
  }

  subscriptions(prefix: string): string[] {
    return [
      ...new Set(
        this.adapters.flatMap((adapter) => adapter.subscriptions(prefix)),
      ),
    ];
  }

  legacyTemperatureTopics(): string[] {
    return this.legacyTemperature.subscriptions();
  }

  legacyDeviceTopics(): string[] {
    return this.legacyFramework.subscriptions();
  }

  route(
    message: DeviceMqttMessage,
  ): (DeviceMqttAdapterResult & { persisted: Promise<void> }) | null {
    for (const adapter of this.adapters) {
      const result = adapter.handle(message);

      if (!result) continue;

      const persistence: Promise<void>[] = [];

      for (const effect of result.effects) {
        if (effect.kind === 'registry') {
          this.registry.ingestRegistryPayload(effect.payload);
        }

        if (effect.kind === 'telemetry') {
          const payload = effect.payload as {
            deviceId: string;
            observedAt?: string;
            origin?: string;
            protocol?: string;
            values?: Record<string, unknown>;
          };

          this.observation.observe({
            deviceId: payload.deviceId,
            observedAt: payload.observedAt || new Date().toISOString(),
            source: payload.origin || payload.protocol || 'unknown',
            values: payload.values || {},
          });

          this.registry.ingestDeviceTelemetry(effect.payload);
          if (this.telemetry)
            persistence.push(
              this.telemetry.capture(
                effect.payload,
                this.registry
                  .getDevices()
                  .find((device) => device.id === payload.deviceId),
                adapter.id,
              ),
            );
        }

        if (effect.kind === 'status') {
          this.registry.ingestDeviceStatus(effect.payload);
        }
      }

      return {
        ...result,
        persisted: Promise.all(persistence).then(() => undefined),
      };
    }

    return null;
  }
}
