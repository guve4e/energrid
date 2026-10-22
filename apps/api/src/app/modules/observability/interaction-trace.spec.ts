import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileInteractionTraceStore } from './file-interaction-trace.store';
import { InteractionTraceSession } from './interaction-trace';

const scope = { tenantId: 'demo', siteId: 'home' };
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'energrid-trace-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('Energrid interaction tracing', () => {
  it('persists correlated stage timings', async () => {
    const store = new FileInteractionTraceStore(directory);
    const trace = new InteractionTraceSession(scope, 'chat', store);

    await trace.measure('core.resolve', async () => 'device-1');
    await trace.measure('device.execute', async () => true);
    const saved = await trace.finish('succeeded');

    expect(saved.traceId).toBeTruthy();
    expect(saved.spans.map(span => span.stage)).toEqual([
      'core.resolve',
      'device.execute',
    ]);
    expect(saved.durationMs).toBeGreaterThanOrEqual(0);

    const restored = await store.list(scope);
    expect(restored).toHaveLength(1);
    expect(restored[0].traceId).toBe(saved.traceId);
  });

  it('records failed stages without swallowing errors', async () => {
    const store = new FileInteractionTraceStore(directory);
    const trace = new InteractionTraceSession(scope, 'chat', store);

    await expect(
      trace.measure('device.execute', async () => {
        throw new Error('connection failed');
      }),
    ).rejects.toThrow('connection failed');

    const saved = await trace.finish('failed');
    expect(saved.spans[0].outcome).toBe('error');
    expect(saved.outcome).toBe('failed');
  });

  it('does not persist operation results or private text', async () => {
    const store = new FileInteractionTraceStore(directory);
    const trace = new InteractionTraceSession(scope, 'chat', store);

    await trace.measure('intent.interpret', async () => ({
      secret: 'private household conversation',
    }));
    await trace.finish('succeeded');

    const [stored] = await store.list(scope);
    expect(JSON.stringify(stored)).not.toContain(
      'private household conversation',
    );
  });

  it('isolates traces by site', async () => {
    const store = new FileInteractionTraceStore(directory);
    const trace = new InteractionTraceSession(scope, 'chat', store);
    await trace.finish('denied');

    expect(await store.list({
      tenantId: 'demo',
      siteId: 'other-house',
    })).toEqual([]);
  });

  it('retains only the configured number of records', async () => {
    const store = new FileInteractionTraceStore(directory, 2);

    for (let i = 0; i < 4; i++) {
      const trace = new InteractionTraceSession(scope, 'chat', store);
      await trace.finish('succeeded');
    }

    expect(await store.list(scope)).toHaveLength(2);
  });

  it('does not permit recording after completion', async () => {
    const store = new FileInteractionTraceStore(directory);
    const trace = new InteractionTraceSession(scope, 'chat', store);
    await trace.finish('succeeded');

    await expect(
      trace.measure('core.resolve', async () => true),
    ).rejects.toThrow('already finished');
  });
});
