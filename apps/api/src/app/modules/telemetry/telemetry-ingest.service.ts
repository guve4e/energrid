import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import {
  validateElectricalReading,
  type ElectricalReading,
} from '@energrid/domain-telemetry';
import { TELEMETRY_CONFIG, TelemetryConfig } from './telemetry.config';
import {
  ConflictingElectricalReadingError,
  TelemetryStore,
} from './telemetry.store';
import { TelemetrySpool } from './telemetry-spool';
import type { RegisteredDevice } from '../devices/device-registry.types';

@Injectable()
export class TelemetryIngestService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelemetryIngestService.name);
  private readonly admissions = new Set<Promise<void>>();
  private running?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private replayBlocked = false;
  private stored = 0;
  private duplicates = 0;
  private rejected = 0;
  private failed = 0;
  private closing = false;
  private lastStoredAt: string | null = null;

  constructor(
    @Inject(TELEMETRY_CONFIG) private readonly config: TelemetryConfig,
    private readonly store: TelemetryStore,
    private readonly spool: TelemetrySpool,
  ) {}

  async onModuleInit() {
    if (!this.config.enabled) return;
    await this.spool.open();
    void this.runCycle();
    this.timer = setInterval(() => {
      void this.runCycle();
    }, this.config.replayIntervalMs);
    this.timer.unref();
  }

  status() {
    return {
      enabled: this.config.enabled,
      storageConfigured: Boolean(this.config.databaseUrl),
      pending: this.spool.status().pending,
      buffer: this.spool.status(),
      replayBlocked: this.replayBlocked,
      stored: this.stored,
      duplicates: this.duplicates,
      rejected: this.rejected,
      failed: this.failed,
      lastStoredAt: this.lastStoredAt,
    };
  }

  /** Only explicitly typed readings enter history. Generic live values are not a storage contract. */
  capture(
    payload: unknown,
    device: RegisteredDevice | undefined,
    source: string,
    now = new Date(),
  ): Promise<void> {
    if (!this.config.enabled) return Promise.resolve();
    if (this.closing)
      return Promise.reject(new Error('Telemetry ingestion is closing'));
    if (!payload || typeof payload !== 'object' || !('readings' in payload))
      return Promise.resolve();
    let readings: ElectricalReading[];
    try {
      const raw = payload as Record<string, unknown>;
      if (
        !device ||
        device.trustStatus !== 'approved' ||
        device.kind !== 'physical' ||
        !device.capabilities.some(
          (c) => c.kind === 'power' && c.actions.includes('read'),
        )
      )
        throw new Error('Unapproved electrical measurement source');
      if (
        raw.deviceId !== device.id ||
        (raw.tenantId !== undefined && raw.tenantId !== device.tenantId) ||
        (raw.siteId !== undefined && raw.siteId !== device.siteId)
      )
        throw new Error('Measurement identity mismatch');
      if (
        !Array.isArray(raw.readings) ||
        raw.readings.length < 1 ||
        raw.readings.length > 32
      )
        throw new Error('Expected between one and 32 readings');
      readings = raw.readings.map((entry) =>
        validateElectricalReading({
          ...(entry && typeof entry === 'object' ? entry : {}),
          tenantId: device.tenantId,
          siteId: device.siteId,
          deviceId: device.id,
          source,
          receivedAt: now.toISOString(),
        }),
      );
    } catch {
      this.rejected++;
      this.logger.warn(
        'Electrical telemetry rejected: invalid contract or unapproved source.',
      );
      // Invalid/unapproved input is deliberately ignored, not retried as an outage.
      return Promise.resolve();
    }
    const accepted = this.spool.enqueue(readings).catch(() => {
      this.failed++;
      this.logger.error(
        'Electrical telemetry could not be buffered; MQTT acknowledgment withheld.',
      );
      throw new Error('Electrical telemetry buffering unavailable');
    });
    this.admissions.add(accepted);
    void accepted.then(
      () => this.admissions.delete(accepted),
      () => this.admissions.delete(accepted),
    );
    return accepted;
  }

  runCycle(): Promise<void> {
    if (!this.config.enabled || this.closing) return Promise.resolve();
    return (this.running ??= this.replay()
      .catch(() => {
        this.failed++;
        this.replayBlocked = true;
        this.logger.error(
          'Telemetry replay paused; unsaved readings remain on disk and will retry.',
        );
      })
      .finally(() => {
        this.running = undefined;
      }));
  }

  private async replay() {
    this.replayBlocked = false;
    for (let processed = 0; processed < 500 && !this.closing; processed++) {
      const entry = await this.spool.peek();
      if (!entry) return;
      let reading: ElectricalReading;
      try {
        reading = validateElectricalReading(entry.value);
      } catch {
        await this.spool.finish(entry, 'invalid-reading');
        this.logger.warn('Invalid buffered telemetry preserved in quarantine.');
        continue;
      }
      try {
        const outcome = await this.store.append(reading);
        // An uncertain COMMIT or local delete failure is safe to retry via the database's natural key.
        await this.spool.finish(entry);
        if (outcome === 'duplicate') this.duplicates++;
        else {
          this.stored++;
          this.lastStoredAt = new Date().toISOString();
        }
      } catch (error) {
        if (!(error instanceof ConflictingElectricalReadingError)) throw error;
        await this.spool.finish(entry, 'conflicting-reading');
        this.logger.warn(
          'Conflicting telemetry preserved in quarantine; existing history unchanged.',
        );
      }
    }
  }

  async flush() {
    await Promise.allSettled([...this.admissions]);
    await this.runCycle();
  }
  async onModuleDestroy() {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    await Promise.allSettled([...this.admissions]);
    await this.running;
  }
}
