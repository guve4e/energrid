import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { DeviceRegistryService } from '../device-registry.service';
import { MqttEvidenceCaptureService } from './mqtt-evidence-capture.service';

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
      reasonCode: 'discovery_read_failed'
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
    const scope = this.currentScope();
    const sources = this.capture.getConfiguredSources(scope);

    const topicsByDevice = new Map<string, string[]>();

    for (const source of sources) {
      const topics = topicsByDevice.get(source.deviceId) ?? [];
      topics.push(source.topic);
      topicsByDevice.set(source.deviceId, topics);
    }

    for (const [deviceId, topics] of topicsByDevice) {
      await this.registerFromEvidence(scope, deviceId, topics);
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
    const scope = this.currentScope();
    const sources = this.capture.getConfiguredSources(scope);

    const source = sources.find(item => item.topic === topic);

    if (!source) {
      return {
        outcome: 'skipped',
        registryUpdated: false,
        reasonCode: 'topic_not_configured',
      };
    }

    const topics = sources
      .filter(item => item.deviceId === source.deviceId)
      .map(item => item.topic);

    return this.registerFromEvidence(
      scope,
      source.deviceId,
      topics,
    );
  }

  private currentScope(): DiscoveryScope {
    const { tenant, site } = this.registry.getSnapshot();

    return {
      tenantId: tenant.id,
      siteId: site.id,
    };
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
