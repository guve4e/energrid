import { Inject, Injectable } from '@nestjs/common';
import { ClassicLevel } from 'classic-level';
import {
  validateElectricalReading,
  type ElectricalReading,
} from '@energrid/domain-telemetry';
import {
  TELEMETRY_CONFIG,
  TELEMETRY_SPOOL_FACTORY,
  TelemetryConfig,
} from './telemetry.config';

export type SpoolDatabase = Pick<
  ClassicLevel<string, unknown>,
  'open' | 'close' | 'get' | 'batch' | 'iterator'
>;
export type SpoolFactory = (directory: string) => SpoolDatabase;
type Operation =
  | { type: 'put'; key: string; value: unknown }
  | { type: 'del'; key: string };
interface Metadata {
  version: 1;
  next: number;
  pending: number;
  quarantined: number;
}
export interface SpoolEntry {
  key: string;
  value: unknown;
}

/** A single-process, synchronously committed local outbox. Never evicts unsaved readings. */
@Injectable()
export class TelemetrySpool {
  private db?: SpoolDatabase;
  private opening?: Promise<void>;
  private poisoned = false;
  private loaded = false;
  private tail: Promise<unknown> = Promise.resolve();
  private meta: Metadata = { version: 1, next: 0, pending: 0, quarantined: 0 };
  private state: 'disabled' | 'not-started' | 'ready' | 'blocked' | 'closed';

  constructor(
    @Inject(TELEMETRY_CONFIG) private readonly config: TelemetryConfig,
    @Inject(TELEMETRY_SPOOL_FACTORY) private readonly factory: SpoolFactory,
  ) {
    this.state = config.enabled ? 'not-started' : 'disabled';
  }

  status() {
    return {
      state: this.state,
      pending: this.loaded ? this.meta.pending : null,
      quarantined: this.loaded ? this.meta.quarantined : null,
      capacity: this.config.maxPendingWrites,
      restartRequired: this.poisoned,
    };
  }

  open(): Promise<void> {
    if (!this.config.enabled) return Promise.resolve();
    if (this.state === 'closed')
      return Promise.reject(new Error('Telemetry spool is closed'));
    return (this.opening ??= this.initialize().catch(() => {
      this.state = 'blocked';
      throw new Error(
        'Telemetry spool could not open; check its storage and exclusive ownership',
      );
    }));
  }

  private async initialize() {
    this.db = this.factory(this.config.spoolDirectory!);
    await this.db.open();
    const value = await this.db.get('metadata');
    if (value === undefined) {
      if ((await this.db.iterator({ limit: 1 }).all()).length)
        throw new Error('Spool metadata missing');
      await this.db.batch(
        [{ type: 'put', key: 'metadata', value: this.meta }],
        { sync: true },
      );
    } else {
      const m = value as Metadata;
      if (
        !m ||
        m.version !== 1 ||
        ![m.next, m.pending, m.quarantined].every(
          (n) => Number.isSafeInteger(n) && n >= 0,
        ) ||
        m.pending + m.quarantined > m.next
      )
        throw new Error('Invalid spool metadata');
      this.meta = m;
    }
    this.loaded = true;
    this.state = 'ready';
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      await this.open();
      try {
        if (this.poisoned)
          throw new Error(
            'Spool requires restart after an uncertain disk write',
          );
        const value = await operation();
        this.state = 'ready';
        return value;
      } catch {
        this.state = 'blocked';
        throw new Error(
          'Telemetry spool operation failed; readings were not acknowledged',
        );
      }
    });
    this.tail = result.catch(() => undefined);
    return result;
  }

  private async commit(operations: Operation[]) {
    try {
      await this.db!.batch<string, unknown>(operations, { sync: true });
    } catch (error) {
      // A failed fsync has an uncertain outcome. Never reuse sequence numbers from stale metadata.
      this.poisoned = true;
      throw error;
    }
  }

  enqueue(input: ElectricalReading[]): Promise<void> {
    return this.serialize(async () => {
      if (!input.length || input.length > 32)
        throw new Error('Invalid batch size');
      const readings = input.map(validateElectricalReading);
      if (
        this.meta.pending + this.meta.quarantined + readings.length >
          this.config.maxPendingWrites ||
        !Number.isSafeInteger(this.meta.next + readings.length)
      )
        throw new Error('Spool capacity exceeded');
      const next = {
        ...this.meta,
        pending: this.meta.pending + readings.length,
        next: this.meta.next + readings.length,
      };
      // Samples and queue accounting commit together, before the MQTT acknowledgment.
      await this.commit([
        ...readings.map((value, index) => ({
          type: 'put' as const,
          key: `p:${String(this.meta.next + index).padStart(16, '0')}`,
          value,
        })),
        { type: 'put', key: 'metadata', value: next },
      ]);
      this.meta = next;
    });
  }

  peek(): Promise<SpoolEntry | undefined> {
    return this.serialize(async () => {
      const entries = await this.db!.iterator({
        gte: 'p:',
        lt: 'q:',
        limit: 1,
      }).all();
      if (Boolean(entries.length) !== Boolean(this.meta.pending))
        throw new Error('Spool accounting mismatch');
      return entries.length
        ? { key: entries[0][0], value: entries[0][1] }
        : undefined;
    });
  }

  finish(
    entry: SpoolEntry,
    reason?: 'conflicting-reading' | 'invalid-reading',
  ): Promise<void> {
    return this.serialize(async () => {
      if (
        !/^p:\d{16}$/.test(entry.key) ||
        (await this.db!.get(entry.key)) === undefined
      )
        throw new Error('Unknown spool entry');
      const next = {
        ...this.meta,
        pending: this.meta.pending - 1,
        quarantined: this.meta.quarantined + (reason ? 1 : 0),
      };
      await this.commit([
        { type: 'del', key: entry.key },
        ...(reason
          ? [
              {
                type: 'put' as const,
                key: `q:${entry.key.slice(2)}`,
                value: { reason, reading: entry.value },
              },
            ]
          : []),
        { type: 'put', key: 'metadata', value: next },
      ]);
      this.meta = next;
    });
  }

  async close() {
    await this.tail;
    await this.opening?.catch(() => undefined);
    this.state = this.config.enabled ? 'closed' : 'disabled';
    await this.db?.close();
  }
}
