import { InteractionTraceSession } from './interaction-trace';
import {
  currentInteractionTrace,
  runWithInteractionTrace,
} from './interaction-trace-context';

const scope = { tenantId: 'tenant-a', siteId: 'home' };

describe('Interaction trace context', () => {
  function createTrace() {
    return new InteractionTraceSession(
      scope,
      'chat',
      { save: jest.fn().mockResolvedValue(undefined) },
    );
  }

  it('preserves the same trace across asynchronous calls', async () => {
    const trace = createTrace();

    await runWithInteractionTrace(trace, async () => {
      expect(currentInteractionTrace()).toBe(trace);

      await Promise.resolve();

      expect(currentInteractionTrace()?.traceId).toBe(trace.traceId);
    });

    expect(currentInteractionTrace()).toBeUndefined();
  });

  it('isolates concurrent conversations', async () => {
    const first = createTrace();
    const second = createTrace();

    const observed = await Promise.all([
      runWithInteractionTrace(first, async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return currentInteractionTrace()?.traceId;
      }),
      runWithInteractionTrace(second, async () => {
        await Promise.resolve();
        return currentInteractionTrace()?.traceId;
      }),
    ]);

    expect(observed).toEqual([
      first.traceId,
      second.traceId,
    ]);
    expect(first.traceId).not.toBe(second.traceId);
  });

  it('rejects scope mismatches when correlating operations', () => {
    const trace = createTrace();

    expect(trace.matchesScope(scope)).toBe(true);
    expect(trace.matchesScope({
      tenantId: 'tenant-b',
      siteId: 'home',
    })).toBe(false);
  });

  it('preserves denied outcomes from nested operations', async () => {
    const trace = createTrace();

    trace.recordOutcome('denied');

    expect(trace.suggestedOutcome).toBe('denied');

    trace.recordOutcome('failed');

    expect(trace.suggestedOutcome).toBe('failed');
  });
});
