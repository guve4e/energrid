import { Inject, Injectable } from '@nestjs/common';
import { ClassicLevel } from 'classic-level';
import type { GenericMeasurementInput } from '@energrid/domain-telemetry';
import { MEASUREMENT_HISTORY_OUTBOX_FACTORY, TELEMETRY_CONFIG, type MeasurementHistoryPolicy, type TelemetryConfig } from '../telemetry.config';

export interface HistoryOutboxItem {
  field: string;
  measurement: GenericMeasurementInput;
  policy: MeasurementHistoryPolicy;
}

export interface HistoryOutboxEntry extends HistoryOutboxItem {
  sampleId: string;
  key: string;
}

export type HistoryOutboxDatabase = Pick<ClassicLevel<string, unknown>, 'open' | 'close' | 'get' | 'batch' | 'iterator'>;
export type HistoryOutboxFactory = (directory: string) => HistoryOutboxDatabase;
type Operation = { type: 'put'; key: string; value: unknown } | { type: 'del'; key: string };
interface Metadata { version: 1; next: number; pending: number }

/** Local, fsync-backed queue for accepted generic measurement history. */
@Injectable()
export class GenericMeasurementHistoryOutbox {
  private db?: HistoryOutboxDatabase;
  private opening?: Promise<void>;
  private tail: Promise<unknown> = Promise.resolve();
  private poisoned = false;
  private closed = false;
  private meta: Metadata = { version: 1, next: 0, pending: 0 };

  constructor(
    @Inject(TELEMETRY_CONFIG) private readonly config: TelemetryConfig,
    @Inject(MEASUREMENT_HISTORY_OUTBOX_FACTORY) private readonly factory: HistoryOutboxFactory,
  ) {}

  open(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('History outbox is closed'));
    return this.opening ??= this.initialize().catch(() => {
      throw new Error('Measurement history outbox could not open; check storage and exclusive ownership');
    });
  }

  private async initialize() {
    this.db = this.factory(this.config.historyOutboxDirectory);
    await this.db.open();
    const value = await this.getMaybe('metadata');
    if (value === undefined) {
      if ((await this.db.iterator({ limit: 1 }).all()).length) throw new Error('Outbox metadata missing');
      await this.db.batch([{ type: 'put', key: 'metadata', value: this.meta }], { sync: true });
      return;
    }
    const meta = value as Metadata;
    if (!meta || meta.version !== 1 || ![meta.next, meta.pending].every(n => Number.isSafeInteger(n) && n >= 0) || meta.pending > meta.next) {
      throw new Error('Invalid history outbox metadata');
    }
    this.meta = meta;
  }

  private async getMaybe(key: string): Promise<unknown> {
    try {
      return await this.database().get(key);
    } catch (error) {
      if ((error as { code?: string })?.code === 'LEVEL_NOT_FOUND') return undefined;
      throw error;
    }
  }

  private database(): HistoryOutboxDatabase {
    if (!this.db) throw new Error('History outbox database is not open');
    return this.db;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      await this.open();
      if (this.poisoned) throw new Error('History outbox requires restart after an uncertain disk write');
      return operation();
    });
    this.tail = result.catch(() => undefined);
    return result;
  }

  private async commit(operations: Operation[]) {
    try {
      await this.database().batch<string, unknown>(operations, { sync: true });
    } catch (error) {
      this.poisoned = true;
      throw error;
    }
  }

  enqueue(items: readonly HistoryOutboxItem[]): Promise<void> {
    return this.serialize(async () => {
      if (!items.length) return;
      const additions: { item: HistoryOutboxItem; sampleId: string }[] = [];
      const seen = new Set<string>();
      for (const item of items) {
        const sampleId = item.measurement.sampleId;
        if (!/^[a-f0-9]{64}$/.test(sampleId)) throw new Error('Invalid history sample identity');
        if (seen.has(sampleId)) continue;
        seen.add(sampleId);
        const existingSequence = await this.getMaybe(`i:${sampleId}`);
        if (existingSequence !== undefined) continue;
        additions.push({ item, sampleId });
      }
      if (!additions.length) return;
      if (this.meta.pending + additions.length > this.config.maxPendingWrites || !Number.isSafeInteger(this.meta.next + additions.length)) {
        throw new Error('Measurement history outbox capacity exceeded');
      }
      const next = { ...this.meta, pending: this.meta.pending + additions.length, next: this.meta.next + additions.length };
      await this.commit([
        ...additions.flatMap(({ item, sampleId }, index) => {
          const sequence = this.meta.next + index;
          return [
            { type: 'put' as const, key: `p:${String(sequence).padStart(16, '0')}`, value: { ...item, sampleId } },
            { type: 'put' as const, key: `i:${sampleId}`, value: sequence },
          ];
        }),
        { type: 'put', key: 'metadata', value: next },
      ]);
      this.meta = next;
    });
  }

  peek(): Promise<HistoryOutboxEntry | undefined> {
    return this.serialize(async () => {
      const entries = await this.database().iterator({ gte: 'p:', lt: 'q:', limit: 1 }).all();
      if (Boolean(entries.length) !== Boolean(this.meta.pending)) throw new Error('History outbox accounting mismatch');
      if (!entries.length) return undefined;
      const key = entries[0][0];
      const value = entries[0][1] as Omit<HistoryOutboxEntry, 'key'> | undefined;
      if (!value || typeof value.sampleId !== 'string' || !value.measurement || !value.policy || typeof value.field !== 'string') throw new Error('Invalid history outbox entry');
      return { ...value, key };
    });
  }

  complete(entry: HistoryOutboxEntry): Promise<void> {
    return this.serialize(async () => {
      if (!/^p:\d{16}$/.test(entry.key)) throw new Error('Unknown history outbox entry');
      const existing = await this.getMaybe(entry.key);
      if (!existing) throw new Error('Unknown history outbox entry');
      const value = existing as { sampleId?: string };
      if (value.sampleId !== entry.sampleId) throw new Error('History outbox identity mismatch');
      const next = { ...this.meta, pending: this.meta.pending - 1 };
      await this.commit([
        { type: 'del', key: entry.key },
        { type: 'del', key: `i:${entry.sampleId}` },
        { type: 'put', key: 'metadata', value: next },
      ]);
      this.meta = next;
    });
  }

  status() { return { pending: this.meta.pending, restartRequired: this.poisoned }; }

  async close() {
    await this.tail;
    await this.opening?.catch(() => undefined);
    this.closed = true;
    await this.db?.close();
  }
}
