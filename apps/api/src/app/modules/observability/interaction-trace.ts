import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export type InteractionOrigin = 'chat' | 'voice' | 'automation' | 'api';

export type InteractionOutcome =
  | 'succeeded'
  | 'denied'
  | 'failed';

export type InteractionStage =
  | 'speech.stt'
  | 'intent.interpret'
  | 'assistant.turn'
  | 'assistant.agent_setup'
  | 'assistant.tool'
  | 'core.resolve'
  | 'core.authorize'
  | 'core.command'
  | 'device.execute'
  | 'assistant.respond'
  | 'speech.tts';

export interface InteractionScope {
  tenantId: string;
  siteId: string;
}

export interface InteractionSpan {
  stage: InteractionStage;
  name?: string;
  offsetMs: number;
  durationMs: number;
  outcome: 'ok' | 'error';
}

export interface InteractionTraceRecord {
  schemaVersion: 1;
  traceId: string;
  scope: InteractionScope;
  origin: InteractionOrigin;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  outcome: InteractionOutcome;
  spans: InteractionSpan[];
}

export interface InteractionTraceStore {
  save(trace: InteractionTraceRecord): Promise<void>;
}

export class InteractionTraceSession {
  readonly traceId = randomUUID();

  private readonly startedAt = new Date().toISOString();
  private readonly startTime = performance.now();
  private readonly spans: InteractionSpan[] = [];
  private finished = false;
  private outcomeHint: InteractionOutcome | null = null;

  constructor(
    private readonly scope: InteractionScope,
    private readonly origin: InteractionOrigin,
    private readonly store: InteractionTraceStore,
  ) {
    if (!scope.tenantId?.trim() || !scope.siteId?.trim()) {
      throw new Error('Interaction trace requires tenant and site scope');
    }
  }

  async measure<T>(
    stage: InteractionStage,
    operation: () => Promise<T>,
    name?: string,
  ): Promise<T> {
    if (this.finished) {
      throw new Error('Interaction trace already finished');
    }

    const start = performance.now();
    let outcome: InteractionSpan['outcome'] = 'ok';

    try {
      return await operation();
    } catch (error) {
      outcome = 'error';
      throw error;
    } finally {
      this.spans.push({
        stage,
        ...(name ? { name } : {}),
        offsetMs: Math.max(0, Math.round(start - this.startTime)),
        durationMs: Math.max(0, Math.round(performance.now() - start)),
        outcome,
      });
    }
  }

  matchesScope(scope: InteractionScope): boolean {
    return this.scope.tenantId === scope.tenantId &&
      this.scope.siteId === scope.siteId;
  }

  recordOutcome(outcome: InteractionOutcome): void {
    if (this.finished) {
      throw new Error('Interaction trace already finished');
    }

    if (outcome === 'failed' ||
        (outcome === 'denied' && this.outcomeHint !== 'failed')) {
      this.outcomeHint = outcome;
    }
  }

  get suggestedOutcome(): InteractionOutcome | null {
    return this.outcomeHint;
  }

  async finish(
    outcome: InteractionOutcome,
  ): Promise<InteractionTraceRecord> {
    if (this.finished) {
      throw new Error('Interaction trace already finished');
    }

    this.finished = true;

    const record: InteractionTraceRecord = {
      schemaVersion: 1,
      traceId: this.traceId,
      scope: { ...this.scope },
      origin: this.origin,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Math.max(
        0,
        Math.round(performance.now() - this.startTime),
      ),
      outcome,
      spans: [...this.spans],
    };

    await this.store.save(record);
    return record;
  }
}
