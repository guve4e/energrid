import { DeviceRegistryService } from '../device-registry.service';
import type {
  ApprovedMqttObservationRoute,
  ApprovedMqttObservationResult,
} from './approved-mqtt-observation.route';
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
import type { PhysicalDeviceInventoryRecord } from '../enrollment/physical-device-inventory.repository';
import type { PhysicalDeviceInventoryService } from '../enrollment/physical-device-inventory.service';
import type { DeviceEnrollmentService } from '../enrollment/device-enrollment.service';

export interface DeviceMqttObservationAdmission {
  deviceId?: string;
  outcome: 'admitted' | 'rejected';
  reasonCode?: string;
}

export class DeviceMqttMessageRouter {
  private readonly legacyTemperature = new LegacyTemperatureMqttAdapter();

  private readonly legacyFramework = new LegacyFrameworkMqttAdapter();

  private readonly adapters: DeviceMqttMessageAdapter[];

  constructor(
    private readonly registry: DeviceRegistryService,
    private readonly observation: DeviceObservationService,
    private readonly telemetry?: TelemetryIngestService,
    private readonly approvedObservations?: ApprovedMqttObservationRoute,
    private readonly physicalInventory?: PhysicalDeviceInventoryService,
    private readonly enrollment?: DeviceEnrollmentService,
  ) {
    this.adapters = [
      this.legacyTemperature,
      new ShellyMqttAdapter(),
      this.legacyFramework,
      new EnergridMqttAdapter(),
    ];
  }

  subscriptions(prefix: string): string[] {
    return [
      ...new Set(
        [
          ...this.adapters.flatMap((adapter) => adapter.subscriptions(prefix)),
          ...(this.approvedObservations?.subscriptions() ?? []),
        ],
      ),
    ];
  }

  legacyTemperatureTopics(): string[] {
    return this.legacyTemperature.subscriptions();
  }

  legacyDeviceTopics(): string[] {
    return this.legacyFramework.subscriptions();
  }

  async route(
    message: DeviceMqttMessage,
  ): Promise<(DeviceMqttAdapterResult & {
    persisted: Promise<void>
    observationAdmission?: Promise<ApprovedMqttObservationResult> | ApprovedMqttObservationResult
    observationAdmissions?: DeviceMqttObservationAdmission[]
    physicalDiscovery?: Promise<PhysicalDeviceInventoryRecord[]>
  }) | null> {
    const receivedAt = new Date().toISOString();
    if (this.approvedObservations?.matches(message.topic)) {
      const observationAdmission = await this.approvedObservations.process(message);
      return {
        reason: 'configured approved observation',
        effects: [],
        persisted: Promise.resolve(),
        observationAdmission,
      };
    }

    for (const adapter of this.adapters) {
      const result = adapter.handle(message);

      if (!result) continue;

      const blockedEffects = new Set<DeviceMqttAdapterResult['effects'][number]>();
      const observationAdmissions: DeviceMqttObservationAdmission[] = [];
      const effectPayloads = new Map<DeviceMqttAdapterResult['effects'][number], unknown>();
      let observationAdmission: ApprovedMqttObservationResult | undefined;
      const { tenant, site } = this.registry.getSnapshot();
      for (const effect of result.effects) {
        if (effect.kind === 'discovery') continue;

        if (effect.kind === 'registry') {
          const payload = effect.payload as { devices?: unknown[] };
          const allowed: unknown[] = [];
          for (const item of payload.devices ?? []) {
            const device = item && typeof item === 'object'
              ? item as { id?: string; deviceId?: string; key?: string }
              : {};
            const deviceId = device.id || device.deviceId || device.key;
            const decision = await this.enrollmentDecision(tenant.id, site.id, deviceId);
            observationAdmissions.push({
              ...(deviceId ? { deviceId } : {}),
              outcome: decision.allowed ? 'admitted' : 'rejected',
              ...(!decision.allowed ? { reasonCode: decision.reasonCode } : {}),
            });
            if (decision.allowed) allowed.push(item);
          }
          if (!allowed.length) blockedEffects.add(effect);
          else effectPayloads.set(effect, { ...payload, devices: allowed });
          continue;
        }

        if (effect.kind !== 'telemetry' && effect.kind !== 'status') continue;
        const rawPayload = effect.payload as {
          deviceId?: string;
          target?: {
            identity?: { value?: string };
            componentKey?: string;
            channel?: number | null;
          };
        };
        const target = rawPayload.target;
        const resolvedDeviceId = rawPayload.deviceId || (
          target?.identity?.value && target.componentKey
            ? this.registry.findApprovedDeviceIdByPhysicalChannel(
                target.identity.value,
                target.componentKey,
                target.channel ?? null,
              ) ?? undefined
            : undefined
        );
        const payload = { ...rawPayload };
        delete payload.target;
        if (resolvedDeviceId) payload.deviceId = resolvedDeviceId;
        effectPayloads.set(effect, payload);
        const decision = await this.enrollmentDecision(tenant.id, site.id, resolvedDeviceId);
        observationAdmissions.push({
          ...(resolvedDeviceId ? { deviceId: resolvedDeviceId } : {}),
          outcome: decision.allowed ? 'admitted' : 'rejected',
          ...(!decision.allowed ? { reasonCode: decision.reasonCode } : {}),
        });
        if (!decision.allowed) blockedEffects.add(effect);
      }

      const physicalDiscovery = result.physicalDiscoveries?.length && this.physicalInventory
        ? Promise.all(result.physicalDiscoveries.map(input => this.physicalInventory!.discover({
            ...input,
            scope: { tenantId: tenant.id, siteId: site.id },
          })))
        : undefined;

      const persistence: Promise<void>[] = [];
      const admittedCount = observationAdmissions.filter(item => item.outcome === 'admitted').length;
      const rejectedCount = observationAdmissions.length - admittedCount;
      if (rejectedCount && !admittedCount) {
        observationAdmission = {
          outcome: 'rejected',
          reasonCode: 'device_not_enrolled',
        };
      } else if (admittedCount) {
        observationAdmission = { outcome: 'admitted' };
      }

      for (const effect of result.effects) {
        if (blockedEffects.has(effect)) continue;
        if (effect.kind === 'discovery') {
          this.registry.registerDiscoveredDevice(
            effect.payload as Parameters<DeviceRegistryService['registerDiscoveredDevice']>[0],
          );
        }

        if (effect.kind === 'registry') {
          this.registry.ingestRegistryPayload(effectPayloads.get(effect) ?? effect.payload);
        }

        if (effect.kind === 'telemetry') {
          const payload = (effectPayloads.get(effect) ?? effect.payload) as {
            deviceId: string;
            observedAt?: string;
            origin?: string;
            protocol?: string;
            values?: Record<string, unknown>;
          };

          this.observation.observe({
            deviceId: payload.deviceId,
            receivedAt,
            source: payload.origin || payload.protocol || 'unknown',
            values: payload.values || {},
          });
          if (!observationAdmissions.length) {
            observationAdmissions.push({ deviceId: payload.deviceId, outcome: 'admitted' });
            observationAdmission = { outcome: 'admitted' };
          }

          const telemetryPayload = effectPayloads.get(effect) ?? effect.payload;
          this.registry.ingestDeviceTelemetry(telemetryPayload);
          if (this.telemetry)
            persistence.push(
              this.telemetry.capture(
                telemetryPayload,
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
        ...(observationAdmissions.length ? { observationAdmissions } : {}),
        persisted: Promise.all(persistence).then(() => undefined),
        ...(observationAdmission ? { observationAdmission } : {}),
        ...(physicalDiscovery ? { physicalDiscovery } : {}),
      };
    }

    return null;
  }

  private async enrollmentDecision(
    tenantId: string,
    siteId: string,
    deviceId?: string,
  ): Promise<{ allowed: true } | { allowed: false; reasonCode: string }> {
    if (!deviceId) return { allowed: false, reasonCode: 'device_id_missing' };
    if (!this.enrollment) return { allowed: false, reasonCode: 'enrollment_unavailable' };
    const enrolled = await this.enrollment.find({ tenantId, siteId, deviceId });
    if (enrolled?.status === 'enrolled') return { allowed: true };
    return {
      allowed: false,
      reasonCode: enrolled ? `enrollment_${enrolled.status}` : 'enrollment_missing',
    };
  }
}
