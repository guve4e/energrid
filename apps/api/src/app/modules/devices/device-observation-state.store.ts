import { ClassicLevel } from 'classic-level';
import { createHash } from 'node:crypto';
import { uptime } from 'node:os';

import {
  processObservationPipeline,
  type DeviceObservationState,
  type ObservationPipelineInput,
  type ObservationPipelineResult,
} from '@energrid/domain-devices';

export interface ObservationScope {
  tenantId: string;
  siteId: string;
}

function scopePrefix(scope: ObservationScope): string {
  if (
    !scope ||
    typeof scope.tenantId !== 'string' ||
    !scope.tenantId.trim() ||
    typeof scope.siteId !== 'string' ||
    !scope.siteId.trim()
  ) {
    throw new Error('Valid tenant and site identity required');
  }

  return (
    `tenant:${encodeURIComponent(scope.tenantId)}:` +
    `site:${encodeURIComponent(scope.siteId)}:`
  );
}

interface StoredDeviceState {
  schemaVersion: 1;
  revision: number;
  nextDecisionSequence: number;
  state: DeviceObservationState | null;
}

export interface StoredObservationDecision {
  schemaVersion: 1;
  tenantId: string;
  siteId: string;
  deviceId: string;
  sequence: number;
  receivedAt: string;
  evidenceId?: string;
  accepted: boolean;
  stage: ObservationPipelineResult['stage'];
  reason: string;
  updatedKeys: string[];
  ignoredKeys: string[];
  rejectedFields: string[];
}

interface StoredEvidenceIndex {
  schemaVersion: 1;
  sequence: number;
  fingerprint: string;
}

interface StoredSourceCursor {
  schemaVersion: 1;
  session: number;
  uptimeMs: number;
  sampleCount: number;
  lastSampleUptimeMs: number;
  receivedAt: string;
  /** Host monotonic uptime survives API process restarts and ignores wall-clock changes. */
  apiUptimeMs?: number;
}

const wallClockToleranceMs = 30_000;

function continuityToleranceMs(elapsedMs: number): number {
  return Math.max(wallClockToleranceMs, elapsedMs * 0.001);
}

function wallClockJump(
  previous: StoredSourceCursor,
  currentApiUptimeMs: number,
  currentObservedAt: string,
): boolean {
  const previousTime = Date.parse(previous.receivedAt);
  const currentTime = Date.parse(currentObservedAt);
  if (!Number.isFinite(previousTime) || !Number.isSafeInteger(currentTime) ||
      !Number.isSafeInteger(previous.apiUptimeMs) || currentApiUptimeMs < previous.apiUptimeMs!) return true;
  const elapsedWallMs = currentTime - previousTime;
  const elapsedApiMs = currentApiUptimeMs - previous.apiUptimeMs!;
  return elapsedWallMs < 0 ||
    Math.abs(elapsedWallMs - elapsedApiMs) > continuityToleranceMs(elapsedApiMs);
}

export type ObservationStoreResult =
  Omit<ObservationPipelineResult, 'stage'> & {
    stage: ObservationPipelineResult['stage'] | 'deduplication';
  };

type Operation =
  | { type: 'put'; key: string; value: unknown }
  | { type: 'del'; key: string };


function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);

    if (encoded === undefined) {
      throw new Error('Unsupported evidence value');
    }

    return encoded;
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }

  const raw = value as Record<string, unknown>;

  return `{${Object.keys(raw)
    .sort()
    .map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(raw[key])}`,
    )
    .join(',')}}`;
}

function evidenceFingerprint(
  input: Omit<ObservationPipelineInput, 'currentState'>,
): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        deviceId: input.binding?.deviceId,
        sourceId: input.binding?.sourceId,
        selector: input.context.selector,
        payload: input.payload,
      }),
    )
    .digest('hex');
}

export class DeviceObservationStateStore {
  private readonly db: ClassicLevel<string, unknown>;

  private tail: Promise<void> = Promise.resolve();
  private opening?: Promise<void>;
  private closing = false;
  private poisoned = false;

  constructor(
    directory: string,
    private readonly decisionLimit = 100,
  ) {
    if (!directory?.trim()) {
      throw new Error('Observation database directory required');
    }

    if (
      !Number.isSafeInteger(decisionLimit) ||
      decisionLimit < 1 ||
      decisionLimit > 10_000
    ) {
      throw new Error('Invalid decision retention limit');
    }

    this.db = new ClassicLevel(directory, {
      valueEncoding: 'json',
    });
  }

  private async open(): Promise<void> {
    this.opening ??= this.db.open();
    await this.opening;
  }

  private serialize<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.closing) {
      return Promise.reject(new Error('Observation store is closing'));
    }

    const result = this.tail.then(async () => {
      if (this.poisoned) {
        throw new Error(
          'Observation store requires recovery after a failed write',
        );
      }

      await this.open();
      return operation();
    });

    this.tail = result.then(
      () => undefined,
      () => undefined,
    );

    return result;
  }

  private stateKey(scope: ObservationScope, deviceId: string): string {
    return `${scopePrefix(scope)}state:${encodeURIComponent(deviceId)}`;
  }

  private evidenceKey(
    scope: ObservationScope,
    deviceId: string,
    evidenceId: string,
  ): string {
    return (
      `${scopePrefix(scope)}evidence:${encodeURIComponent(deviceId)}:` +
      encodeURIComponent(evidenceId)
    );
  }

  private sourceCursorKey(
    scope: ObservationScope,
    deviceId: string,
    sourceId: string,
  ): string {
    return (
      `${scopePrefix(scope)}source-cursor:${encodeURIComponent(deviceId)}:` +
      encodeURIComponent(sourceId)
    );
  }

  /**
   * Build a retry-stable identity for a source sample whose counters are
   * monotonic only for one device boot. A counter reset starts a new session.
   * Cursor state is durable so API restarts do not make a repeated HTTP poll
   * look like a new sample.
   */
  sourceSampleEvidenceId(
    scope: ObservationScope,
    deviceId: string,
    sourceId: string,
    sample: {
      uptimeMs: number;
      sampleCount: number;
      lastSampleUptimeMs: number;
      observedAt?: string;
      apiUptimeMs?: number;
    },
  ): Promise<string> {
    return this.serialize(async () => {
      if (!deviceId?.trim() || !sourceId?.trim() ||
        !Number.isSafeInteger(sample.uptimeMs) || sample.uptimeMs < 0 ||
        !Number.isSafeInteger(sample.sampleCount) || sample.sampleCount < 1 ||
        !Number.isSafeInteger(sample.lastSampleUptimeMs) || sample.lastSampleUptimeMs < 0) {
        throw new Error('Invalid source sample cursor');
      }
      const observedAt = sample.observedAt || new Date().toISOString();
      if (!Number.isFinite(Date.parse(observedAt))) throw new Error('Invalid source sample observation time');
      const apiUptimeMs = sample.apiUptimeMs ?? Math.floor(uptime() * 1000);
      if (!Number.isSafeInteger(apiUptimeMs) || apiUptimeMs < 0) {
        throw new Error('Invalid API monotonic uptime');
      }

      const key = this.sourceCursorKey(scope, deviceId, sourceId);
      let previous: StoredSourceCursor | undefined;
      try {
        previous = await this.db.get(key) as StoredSourceCursor;
      } catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) ||
          error.code !== 'LEVEL_NOT_FOUND') throw error;
      }

      if (previous && (previous.schemaVersion !== 1 ||
        !Number.isSafeInteger(previous.session) || previous.session < 0 ||
        !Number.isSafeInteger(previous.uptimeMs) || previous.uptimeMs < 0 ||
        !Number.isSafeInteger(previous.sampleCount) || previous.sampleCount < 0 ||
        !Number.isSafeInteger(previous.lastSampleUptimeMs) || previous.lastSampleUptimeMs < 0 ||
        !Number.isFinite(Date.parse(previous.receivedAt)) ||
        (previous.apiUptimeMs !== undefined &&
          (!Number.isSafeInteger(previous.apiUptimeMs) || previous.apiUptimeMs < 0)))) {
        throw new Error('Invalid persisted source sample cursor');
      }

      const uptimeReset = previous && sample.uptimeMs < previous.uptimeMs;
      const sampleCountReset = previous && sample.sampleCount < previous.sampleCount;
      const sampleTimeReset = previous && sample.lastSampleUptimeMs < previous.lastSampleUptimeMs;
      // Treat a boot as proven only when firmware uptime and both per-boot
      // sample counters reset together. Partial regressions can be corruption,
      // rollover, or an inconsistent response, and cannot mint a new identity.
      const countersReset = !!(uptimeReset && sampleCountReset && sampleTimeReset);
      const partialCounterReset = !!(uptimeReset || sampleCountReset || sampleTimeReset) && !countersReset;

      if (previous) {
        // Never infer a firmware boot from wall time. Reject discontinuities
        // until the API host clock and monotonic clock agree again.
        if (previous.apiUptimeMs !== undefined && wallClockJump(previous, apiUptimeMs, observedAt)) {
          throw new Error('source_sample_session_ambiguous');
        }

        // A persisted cursor from the earlier format has no monotonic anchor.
        // A direct device-counter reset is still reliable; otherwise fail closed.
        if (previous.apiUptimeMs === undefined && !countersReset) {
          throw new Error('source_sample_session_ambiguous');
        }

        if (partialCounterReset) {
          throw new Error('source_sample_session_ambiguous');
        }

        if (!countersReset) {
          const elapsedApiMs = apiUptimeMs - previous.apiUptimeMs!;
          const elapsedDeviceMs = sample.uptimeMs - previous.uptimeMs;
          if (Math.abs(elapsedDeviceMs - elapsedApiMs) > continuityToleranceMs(elapsedApiMs)) {
            throw new Error('source_sample_session_ambiguous');
          }
        }
      }

      const reset = countersReset;
      const session = previous ? previous.session + (reset ? 1 : 0) : 0;
      if (!Number.isSafeInteger(session)) throw new Error('Source session exhausted');

      await this.db.put(key, {
        schemaVersion: 1,
        session,
        uptimeMs: sample.uptimeMs,
        sampleCount: sample.sampleCount,
        lastSampleUptimeMs: sample.lastSampleUptimeMs,
        receivedAt: observedAt,
        apiUptimeMs,
      } satisfies StoredSourceCursor, { sync: true });

      return `${sourceId}:${deviceId}:boot-${session}:sample-${sample.sampleCount}-${sample.lastSampleUptimeMs}`;
    });
  }

  private decisionKey(
    scope: ObservationScope,
    deviceId: string,
    sequence: number,
  ): string {
    return (
      `${scopePrefix(scope)}decision:${encodeURIComponent(deviceId)}:` +
      String(sequence).padStart(16, '0')
    );
  }

  private async readRecord(
    scope: ObservationScope,
    deviceId: string,
  ): Promise<StoredDeviceState> {
    let value: unknown;

    try {
      value = await this.db.get(this.stateKey(scope, deviceId));
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'LEVEL_NOT_FOUND'
      ) {
        value = undefined;
      } else {
        throw error;
      }
    }

    if (value === undefined) {
      return {
        schemaVersion: 1,
        revision: 0,
        nextDecisionSequence: 0,
        state: null,
      };
    }

    if (
      !value ||
      typeof value !== 'object' ||
      (value as StoredDeviceState).schemaVersion !== 1
    ) {
      throw new Error('Invalid stored observation schema');
    }

    const record = value as StoredDeviceState;

    if (
      !Number.isSafeInteger(record.revision) ||
      record.revision < 0 ||
      !Number.isSafeInteger(record.nextDecisionSequence) ||
      record.nextDecisionSequence < 0 ||
      (record.state !== null &&
        (typeof record.state !== 'object' ||
          record.state.deviceId !== deviceId ||
          !record.state.fields ||
          typeof record.state.fields !== 'object'))
    ) {
      throw new Error('Invalid stored observation state');
    }

    return record;
  }

  /**
   * Read the latest durable state.
   *
   * The returned object is detached from internal storage.
   */
  getState(
    scope: ObservationScope,
    deviceId: string,
  ): Promise<DeviceObservationState | null> {
    return this.serialize(async () => {
      const record = await this.readRecord(scope, deviceId);
      return structuredClone(record.state);
    });
  }

  /**
   * Single-writer transition.
   *
   * The binding and authority policy MUST originate from
   * trusted installation configuration.
   *
   * This method is not an MQTT authentication boundary.
   */
  process(
    scope: ObservationScope,
    deviceId: string,
    input: Omit<ObservationPipelineInput, 'currentState'>,
  ): Promise<ObservationStoreResult> {
    return this.serialize(async () => {
      if (!deviceId?.trim()) {
        throw new Error('Device identity required');
      }

      if (
        input.binding &&
        input.binding.deviceId !== deviceId
      ) {
        throw new Error('Binding identity mismatch');
      }

      const previous = await this.readRecord(scope, deviceId);

      const evidenceId = input.context.evidenceId;

      if (
        evidenceId !== undefined &&
        (
          typeof evidenceId !== 'string' ||
          !evidenceId.trim() ||
          evidenceId.length > 256
        )
      ) {
        throw new Error('Invalid evidence identity');
      }

      const fingerprint = evidenceId
        ? evidenceFingerprint(input)
        : undefined;

      if (evidenceId) {
        let existing: unknown;

        try {
          existing = await this.db.get(
            this.evidenceKey(scope, deviceId, evidenceId),
          );
        } catch (error) {
          if (
            !error ||
            typeof error !== 'object' ||
            !('code' in error) ||
            error.code !== 'LEVEL_NOT_FOUND'
          ) {
            throw error;
          }
        }

        if (existing !== undefined) {
          const index = existing as StoredEvidenceIndex;

          if (
            !index ||
            index.schemaVersion !== 1 ||
            !Number.isSafeInteger(index.sequence) ||
            typeof index.fingerprint !== 'string'
          ) {
            throw new Error('Corrupted evidence index');
          }

          return {
            accepted: false,
            stage: 'deduplication',
            reason:
              index.fingerprint === fingerprint
                ? 'duplicate_evidence'
                : 'evidence_id_conflict',
            deviceId,
            updatedKeys: [],
            ignoredKeys: [],
            rejectedFields: [],
            state: structuredClone(previous.state),
          };
        }
      }

      if (
        !Number.isSafeInteger(previous.nextDecisionSequence + 1)
      ) {
        throw new Error('Observation sequence exhausted');
      }

      const result = processObservationPipeline({
        ...input,
        currentState: previous.state,
      });

      const sequence = previous.nextDecisionSequence;

      const decision: StoredObservationDecision = {
        schemaVersion: 1,
        tenantId: scope.tenantId,
        siteId: scope.siteId,
        deviceId,
        sequence,
        receivedAt: input.context.receivedAt,
        evidenceId: input.context.evidenceId,
        accepted: result.accepted,
        stage: result.stage,
        reason: result.reason,
        updatedKeys: [...result.updatedKeys],
        ignoredKeys: [...result.ignoredKeys],
        rejectedFields: [...result.rejectedFields],
      };

      const next: StoredDeviceState = {
        schemaVersion: 1,
        revision: previous.revision + (result.accepted ? 1 : 0),
        nextDecisionSequence: sequence + 1,
        state: result.accepted
          ? result.state
          : previous.state,
      };

      const operations: Operation[] = [
        {
          type: 'put',
          key: this.stateKey(scope, deviceId),
          value: next,
        },
        {
          type: 'put',
          key: this.decisionKey(scope, deviceId, sequence),
          value: decision,
        },
      ];

      if (evidenceId && fingerprint) {
        operations.push({
          type: 'put',
          key: this.evidenceKey(scope, deviceId, evidenceId),
          value: {
            schemaVersion: 1,
            sequence,
            fingerprint,
          } satisfies StoredEvidenceIndex,
        });
      }

      // Bounded decision history, per device.
      if (sequence >= this.decisionLimit) {
        const expiredSequence = sequence - this.decisionLimit;

        const expiredKey = this.decisionKey(scope, deviceId,
          expiredSequence,
        );

        const expired = await this.db.get(expiredKey) as
          | StoredObservationDecision
          | undefined;

        if (!expired || expired.sequence !== expiredSequence) {
          throw new Error('Decision retention index inconsistent');
        }

        operations.push({
          type: 'del',
          key: expiredKey,
        });

        if (expired.evidenceId) {
          operations.push({
            type: 'del',
            key: this.evidenceKey(scope, deviceId,
              expired.evidenceId,
            ),
          });
        }
      }

      try {
        // State and decision commit atomically.
        await this.db.batch(operations, { sync: true });
      } catch (error) {
        // The outcome of an interrupted write may be uncertain.
        // Stop admitting updates until the store is reopened.
        this.poisoned = true;
        throw error;
      }

      return {
        ...result,
        state: structuredClone(next.state),
      };
    });
  }

  decisions(
    scope: ObservationScope,
    deviceId: string,
    limit = 50,
  ): Promise<StoredObservationDecision[]> {
    return this.serialize(async () => {
      const prefix = `${scopePrefix(scope)}decision:${encodeURIComponent(deviceId)}:`;

      const entries = this.db.iterator({
        gte: prefix,
        lt: `${prefix}\uffff`,
        reverse: true,
        limit: Math.min(
          this.decisionLimit,
          Math.max(1, Math.floor(limit)),
        ),
      });

      const results: StoredObservationDecision[] = [];

      for await (const [, value] of entries) {
        results.push(value as StoredObservationDecision);
      }

      return results;
    });
  }

  async close(): Promise<void> {
    if (this.closing) return;

    this.closing = true;
    await this.tail;
    await this.opening?.catch(() => undefined);
    await this.db.close();
  }
}
