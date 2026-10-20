import {
  Injectable,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import { createHash } from 'node:crypto';

import {
  MqttCapturedEvidenceStore,
  type MqttCaptureScope,
} from '../../llm/mqtt-captured-evidence.store';

interface CaptureBinding {
  scope: MqttCaptureScope;
  deviceId: string;
  topic: string;
}

export type MqttEvidenceCaptureResult =
  | { outcome: 'persisted'; evidenceId: string }
  | {
      outcome: 'skipped'
      reasonCode: 'topic_not_bound' | 'store_unavailable' | 'queue_full'
    }

function validId(value: unknown): value is string {
  return typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 160;
}

function parseBindings(raw: string | undefined): CaptureBinding[] {
  if (!raw?.trim()) return [];

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Invalid HOME_MQTT_EVIDENCE_BINDINGS_JSON');
  }

  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.length > 32
  ) {
    throw new Error('Invalid MQTT evidence binding count');
  }

  const bindings: CaptureBinding[] = [];
  const topics = new Set<string>();

  for (const item of parsed) {
    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item)
    ) {
      throw new Error('Invalid MQTT evidence binding');
    }

    const entry = item as Record<string, unknown>;
    const scope = entry.scope as Record<string, unknown> | undefined;

    if (
      !scope ||
      !validId(scope.tenantId) ||
      !validId(scope.siteId) ||
      !validId(entry.deviceId) ||
      typeof entry.topic !== 'string' ||
      entry.topic.length === 0 ||
      entry.topic.length > 512 ||
      /[+#\0]/.test(entry.topic) ||
      entry.topic.startsWith('$SYS/') ||
      topics.has(entry.topic)
    ) {
      throw new Error('Invalid or duplicate MQTT evidence topic binding');
    }

    topics.add(entry.topic);

    bindings.push({
      scope: {
        tenantId: scope.tenantId,
        siteId: scope.siteId,
      },
      deviceId: entry.deviceId,
      topic: entry.topic,
    });
  }

  return bindings;
}

@Injectable()
export class MqttEvidenceCaptureService implements OnModuleDestroy {
  private readonly logger =
    new Logger(MqttEvidenceCaptureService.name);

  private readonly bindings: Map<string, CaptureBinding>;
  private readonly store: MqttCapturedEvidenceStore | null;
  private readonly storeDiagnosticId: string;

  private pending: Promise<void> = Promise.resolve();
  private queued = 0;

  constructor() {
    const configs = parseBindings(
      process.env.HOME_MQTT_EVIDENCE_BINDINGS_JSON,
    );

    this.bindings = new Map(
      configs.map((binding) => [binding.topic, binding]),
    );

    if (configs.length === 0) {
      this.store = null;
      this.storeDiagnosticId = 'disabled';
      return;
    }

    const directory =
      process.env.HOME_MQTT_EVIDENCE_STORE_DIRECTORY?.trim();

    if (!directory) {
      throw new Error(
        'HOME_MQTT_EVIDENCE_STORE_DIRECTORY is required',
      );
    }

    this.store = new MqttCapturedEvidenceStore(directory);
    this.storeDiagnosticId = createHash('sha256')
      .update(directory)
      .digest('hex')
      .slice(0, 12);
  }

  subscriptions(): string[] {
    return [...this.bindings.keys()];
  }

  matches(topic: string): boolean {
    return this.bindings.has(topic);
  }

  /**
   * Record only explicitly configured topics.
   *
   * This write is independent of observation admission
   * and MQTT acknowledgments.
   */
  capture(
    topic: string,
    payloadText: string,
  ): Promise<MqttEvidenceCaptureResult> {
    const binding = this.bindings.get(topic);

    if (!binding || !this.store) {
      if (topic === 'devices/temp-boiler-room/data') {
        this.logger.warn(
          `[MQTT EVIDENCE DIAG] capture_skipped topic=devices/temp-boiler-room/data binding=${Boolean(binding)} storeAvailable=${Boolean(this.store)}`,
        );
      }
      return Promise.resolve({
        outcome: 'skipped',
        reasonCode: !binding ? 'topic_not_bound' : 'store_unavailable',
      });
    }

    if (this.queued >= 64) {
      if (topic === 'devices/temp-boiler-room/data') {
        this.logger.warn(
          '[MQTT EVIDENCE DIAG] capture_dropped topic=devices/temp-boiler-room/data reason=queue_full',
        );
      }
      this.logger.warn(
        'MQTT evidence capture queue full; dropping evidence',
      );
      return Promise.resolve({ outcome: 'skipped', reasonCode: 'queue_full' });
    }

    if (topic === 'devices/temp-boiler-room/data') {
      this.logger.log(
        `[MQTT EVIDENCE DIAG] capture_queued topic=devices/temp-boiler-room/data store=${this.storeDiagnosticId}`,
      );
    }

    this.queued++;

    const write = this.pending.then(async () => {
      try {
        const id = await this.store!.capture({
          scope: binding.scope,
          deviceId: binding.deviceId,
          topic,
          payloadText,
        });
        if (topic === 'devices/temp-boiler-room/data') {
          this.logger.log(
            `[MQTT EVIDENCE DIAG] capture_persisted topic=devices/temp-boiler-room/data store=${this.storeDiagnosticId} evidenceId=${id}`,
          );
        }
        return { outcome: 'persisted' as const, evidenceId: id };
      } catch (error) {
        if (topic === 'devices/temp-boiler-room/data') {
          const errorName =
            error instanceof Error ? error.name : 'UnknownError';
          this.logger.error(
            `[MQTT EVIDENCE DIAG] capture_failed topic=devices/temp-boiler-room/data store=${this.storeDiagnosticId} error=${errorName}`,
          );
        }
        throw error;
      }
    });

    // Keep the queue usable after an individual write fails.
    this.pending = write.then(
      () => undefined,
      () => undefined,
    );

    return write.finally(() => {
      this.queued--;
    });
  }

  /**
   * Read only configured device evidence, never arbitrary
   * records supplied by an LLM or API caller.
   */
  getConfiguredSources(
    scope: MqttCaptureScope,
  ): Array<{ deviceId: string; topic: string }> {
    return [...this.bindings.values()]
      .filter(binding =>
        binding.scope.tenantId === scope.tenantId &&
        binding.scope.siteId === scope.siteId,
      )
      .map(binding => ({
        deviceId: binding.deviceId,
        topic: binding.topic,
      }));
  }

  async getCaptureStatus(
    scope: MqttCaptureScope,
    deviceId: string,
  ) {
    const topics = [...this.bindings.values()]
      .filter((binding) =>
        binding.deviceId === deviceId &&
        binding.scope.tenantId === scope.tenantId &&
        binding.scope.siteId === scope.siteId,
      )
      .map((binding) => binding.topic);

    if (!topics.length) {
      return {
        enabled: false,
        deviceId,
        topics: [],
        samplesInWindow: 0,
        latestCapturedAt: null,
      };
    }

    const { snapshot, samples } =
      await this.readInvestigationEvidence(scope, deviceId);

    const times = snapshot.evidence
      .map((item) => item.observedAt)
      .filter((value) => Number.isFinite(Date.parse(value)));

    const latestCapturedAt = times.sort().at(-1) ?? null;
    if (deviceId === 'temp-boiler-room') {
      this.logger.log(
        `[MQTT EVIDENCE DIAG] status_read deviceId=temp-boiler-room store=${this.storeDiagnosticId} samples=${samples.length} latestCapturedAt=${latestCapturedAt ?? 'null'}`,
      );
    }

    return {
      enabled: true,
      deviceId,
      topics,
      samplesInWindow: samples.length,
      latestCapturedAt,
    };
  }

  async readInvestigationEvidence(
    scope: MqttCaptureScope,
    deviceId: string,
  ) {
    if (!this.store) {
      throw new Error('MQTT evidence capture is disabled');
    }

    const configured = [...this.bindings.values()].some(
      (binding) =>
        binding.scope.tenantId === scope.tenantId &&
        binding.scope.siteId === scope.siteId &&
        binding.deviceId === deviceId,
    );

    if (!configured) {
      throw new Error('No MQTT capture binding for this device');
    }

    await this.pending;

    return this.store.readInvestigationEvidence(
      scope,
      deviceId,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.pending;
    await this.store?.close();
  }
}
