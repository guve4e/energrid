import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';

import { DeviceRegistryService } from '../device-registry.service';
import { MqttEvidenceCaptureService } from './mqtt-evidence-capture.service';
import {
  PHYSICAL_DEVICE_INVENTORY_SERVICE,
} from '../enrollment/device-enrollment.module';
import type {
  PhysicalDeviceDiscovery,
  PhysicalDeviceInventoryRecord,
} from '../enrollment/physical-device-inventory.repository';
import type { PhysicalDeviceInventoryService } from '../enrollment/physical-device-inventory.service';

interface DiscoveryScope {
  tenantId: string;
  siteId: string;
}

export type MqttEvidenceDiscoveryResult =
  | { outcome: 'refreshed'; registryUpdated: true }
  | {
      outcome: 'skipped'
      registryUpdated: false
      reasonCode:
        | 'topic_not_configured'
        | 'already_projected'
        | 'no_evidence_samples'
        | 'device_already_approved'
    }
  | {
      outcome: 'failed'
      registryUpdated: false
      reasonCode: 'discovery_read_failed' | 'inventory_unavailable'
    }

/**
 * Projects configured MQTT evidence into reviewable Discovery candidates.
 *
 * Never enrolls a device, grants observation authority, enables
 * commands, infers LAN identity, or claims connectivity.
 */
@Injectable()
export class MqttEvidenceDiscoveryService implements OnModuleInit {
  private readonly logger =
    new Logger(MqttEvidenceDiscoveryService.name);

  // Avoid repeatedly projecting the same candidate for every MQTT message.
  private readonly projected = new Set<string>();
  private readonly inFlight = new Map<string, Promise<MqttEvidenceDiscoveryResult>>();

  constructor(
    private readonly capture: MqttEvidenceCaptureService,
    private readonly registry: DeviceRegistryService,
    @Optional()
    @Inject(PHYSICAL_DEVICE_INVENTORY_SERVICE)
    private readonly physicalInventory?: PhysicalDeviceInventoryService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.registry.ensureInstallationsLoaded();

    try {
      await this.refresh();
    } catch (error) {
      this.logger.warn(
        `MQTT evidence discovery unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Restore candidates from evidence already saved before startup.
   */
  async refresh(): Promise<void> {
    const sources = this.capture.listConfiguredBindings();
    const groups = new Map<string, { tenantId: string; siteId: string; deviceId: string; topics: string[] }>();
    for (const source of sources) {
      const key = JSON.stringify([source.scope.tenantId, source.scope.siteId, source.deviceId]);
      const group = groups.get(key) ?? { ...source.scope, deviceId: source.deviceId, topics: [] };
      group.topics.push(source.topic);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      await this.registerFromEvidence(
        { tenantId: group.tenantId, siteId: group.siteId },
        group.deviceId,
        group.topics,
      );
    }

    // Physical Inventory is the durable source for Shelly protocol claims.
    // Reproject those records after restart; never infer ownership from the
    // process's default site or from a topic/payload by itself.
    if (this.physicalInventory) {
      const scopes = new Map(sources.map(source => [
        JSON.stringify([source.scope.tenantId, source.scope.siteId]), source.scope,
      ]));
      for (const scope of scopes.values()) {
        const records = await this.physicalInventory.list(scope);
        for (const record of records) {
          if (record.identity?.namespace !== 'mqtt:shelly-protocol-id' ||
              record.identityEvidenceSource !== 'mqtt_protocol_message') continue;
          this.registerShellyRecord(record);
        }
      }
    }
  }

  /**
   * Called after evidence capture completes.
   *
   * Only the configured source belonging to the captured topic
   * is considered. Other devices are not re-investigated.
   */
  async refreshForTopic(
    topic: string,
  ): Promise<MqttEvidenceDiscoveryResult> {
    const source = this.capture.getConfiguredBindingForTopic(topic);

    if (!source) {
      return {
        outcome: 'skipped',
        registryUpdated: false,
        reasonCode: 'topic_not_configured',
      };
    }

    const topics = this.capture.listConfiguredBindings()
      .filter(item => item.deviceId === source.deviceId &&
        item.scope.tenantId === source.scope.tenantId &&
        item.scope.siteId === source.scope.siteId)
      .map(item => item.topic);

    return this.registerFromEvidence(
      source.scope,
      source.deviceId,
      topics,
    );
  }

  /**
   * Shelly NotifyStatus is nested and therefore intentionally not accepted by
   * the generic flat-payload evidence capture store. Project only its typed,
   * protocol-observed component evidence when an exact source has an
   * explicit server-side tenant/site binding.
   */
  async projectShellyMessage(
    topic: string,
    discoveries: readonly Omit<PhysicalDeviceDiscovery, 'scope'>[],
  ): Promise<PhysicalDeviceInventoryRecord[] | null> {
    const binding = this.capture.getConfiguredBindingForTopic(topic);
    if (!binding || !discoveries.length || !this.physicalInventory) return null;

    const identities = new Set(discoveries.map(item =>
      `${item.identity.namespace}:${item.identity.value.toLowerCase()}`,
    ));
    if (identities.size !== 1 || discoveries.some(item =>
      item.identity.namespace !== 'mqtt:shelly-protocol-id' ||
      item.evidenceSource !== 'mqtt_protocol_message' ||
      !Number.isFinite(Date.parse(item.observedAt)) ||
      item.endpoint?.address !== topic || item.endpoint.protocol !== 'mqtt')) return null;

    const records: PhysicalDeviceInventoryRecord[] = [];
    for (const discovery of discoveries) {
      records.push(await this.physicalInventory.discover({
        ...discovery,
        scope: binding.scope,
      }));
    }

    const merged = records.at(-1);
    if (merged) this.registerShellyRecord(merged);
    return records;
  }

  private registerShellyRecord(record: PhysicalDeviceInventoryRecord): void {
    if (!record.identity || record.identity.namespace !== 'mqtt:shelly-protocol-id') return;
    const physicalId = record.identity.value;
    const approved = this.registry.getDevices(true).some(device =>
      device.trustStatus === 'approved' &&
      device.tenantId === record.scope.tenantId &&
      device.siteId === record.scope.siteId &&
      (device.id === physicalId || device.id.startsWith(`${physicalId}:`) ||
        device.metadata?.physicalId === physicalId),
    );
    if (approved) return;

    for (const component of record.components) {
      const id = `${physicalId}:${component.key}`;
      this.registry.registerDiscoveredDevice({
        id,
        tenantId: record.scope.tenantId,
        siteId: record.scope.siteId,
        displayName: `Shelly ${physicalId} · ${component.key}`,
        suggestedName: `${physicalId} ${component.key}`,
        suggestedRoom: 'Unknown',
        protocol: 'mqtt',
        transport: 'mqtt',
        driver: 'shelly-discovered',
        target: record.endpoints.find(endpoint => endpoint.protocol === 'mqtt')?.address,
        source: 'mqtt',
        capabilities: component.capabilities,
        confidence: 0.45,
        reason: 'MQTT reports this Shelly identity and component. Physical identity is unverified; verify the device independently before enrollment.',
        metadata: {
          physicalId,
          component: component.key,
          identityEvidenceSource: 'mqtt-claimed-protocol-id',
          verificationStatus: 'unverified',
          mqttObservedAt: component.lastSeenAt,
          mqttSourceTopic: record.endpoints.find(endpoint => endpoint.protocol === 'mqtt')?.address ?? '',
        },
      });
    }
  }

  private async registerFromEvidence(
    scope: DiscoveryScope,
    deviceId: string,
    topics: string[],
  ): Promise<MqttEvidenceDiscoveryResult> {
    const key = JSON.stringify([
      scope.tenantId,
      scope.siteId,
      deviceId,
    ]);

    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const operation = this.projectEvidence(scope, deviceId, topics)
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, operation);
    return operation;
  }

  private async projectEvidence(
    scope: DiscoveryScope,
    deviceId: string,
    topics: string[],
  ): Promise<MqttEvidenceDiscoveryResult> {
    const key = JSON.stringify([scope.tenantId, scope.siteId, deviceId]);

    if (this.projected.has(key)) {
      return {
        outcome: 'skipped',
        registryUpdated: false,
        reasonCode: 'already_projected',
      };
    }

    try {
      const { samples } =
        await this.capture.readInvestigationEvidence(scope, deviceId);

      // Configuration alone is not discovery evidence.
      if (!samples.length) {
        return {
          outcome: 'skipped',
          registryUpdated: false,
          reasonCode: 'no_evidence_samples',
        };
      }

      const capabilities: Array<'temperature' | 'humidity'> = [];

      for (const field of ['temperature', 'humidity'] as const) {
        const observed = samples.some(sample => {
          const payload = sample.payload;

          return (
            payload !== null &&
            typeof payload === 'object' &&
            !Array.isArray(payload) &&
            typeof payload[field] === 'number' &&
            Number.isFinite(payload[field])
          );
        });

        if (observed) capabilities.push(field);
      }

      const registryUpdated = this.registry.registerDiscoveredDevice({
        id: deviceId,
        tenantId: scope.tenantId,
        siteId: scope.siteId,
        displayName: `MQTT source ${deviceId}`,
        suggestedName: deviceId,
        protocol: 'mqtt',
        driver: 'mqtt-evidence-pending-profile',
        target: topics[0],
        source: 'mqtt',
        capabilities,
        confidence: 0.55,
        reason:
          'Captured MQTT evidence exists. Physical identity, ' +
          'observation authority and integration are not yet verified.',
        metadata: {
          mqttEvidenceCandidate: true,
          mqttEvidenceTopic: topics[0],
          mqttEvidenceSamples: samples.length,
        },
      });

      if (!registryUpdated) {
        return {
          outcome: 'skipped',
          registryUpdated: false,
          reasonCode: 'device_already_approved',
        };
      }

      this.projected.add(key);
      return { outcome: 'refreshed', registryUpdated: true };
    } catch (error) {
      // A failed read is retryable when more evidence arrives.
      this.logger.warn(
        `MQTT discovery failed for ${deviceId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return {
        outcome: 'failed',
        registryUpdated: false,
        reasonCode: 'discovery_read_failed',
      };
    }
  }
}
