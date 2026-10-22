import {
  InteractionTraceSession,
} from './interaction-trace';
import { runWithInteractionTrace } from './interaction-trace-context';
import { instrumentLocalTools } from './instrument-local-tools';

const scope = {
  tenantId: 'tenant-a',
  siteId: 'house-a',
};

function harness() {
  const save = jest.fn().mockResolvedValue(undefined);

  const trace = new InteractionTraceSession(
    scope,
    'chat',
    { save },
  );

  const execute = jest.fn(async (deviceId: string) => ({
    status: 'resolved',
    deviceId,
  }));

  const [tool] = instrumentLocalTools(scope, [{
    name: 'resolve_device_target',
    execute,
  }]);

  return { trace, tool, execute, save };
}

describe('Local agent tool tracing', () => {
  it('records tool name and duration in the parent trace', async () => {
    const h = harness();

    const result = await runWithInteractionTrace(
      h.trace,
      () => h.tool.execute('kitchen-light'),
    );

    expect(result).toEqual({
      status: 'resolved',
      deviceId: 'kitchen-light',
    });

    expect(h.execute).toHaveBeenCalledWith('kitchen-light');

    const record = await h.trace.finish('succeeded');

    expect(record.spans).toEqual([
      expect.objectContaining({
        stage: 'assistant.tool',
        name: 'resolve_device_target',
        outcome: 'ok',
        durationMs: expect.any(Number),
      }),
    ]);

    // Never save the tool payload.
    expect(JSON.stringify(record)).not.toContain(
      'kitchen-light',
    );
    expect(h.save).toHaveBeenCalledTimes(1);
  });

  it('preserves errors and records failed tool stages', async () => {
    const h = harness();
    h.execute.mockRejectedValueOnce(
      new Error('Device unavailable'),
    );

    await expect(
      runWithInteractionTrace(
        h.trace,
        () => h.tool.execute('unavailable'),
      ),
    ).rejects.toThrow('Device unavailable');

    const record = await h.trace.finish('failed');

    expect(record.spans[0]).toMatchObject({
      stage: 'assistant.tool',
      outcome: 'error',
    });
  });

  it('does not attach tools to another site trace', async () => {
    const h = harness();

    const other = new InteractionTraceSession(
      { tenantId: 'tenant-a', siteId: 'other-house' },
      'chat',
      { save: jest.fn().mockResolvedValue(undefined) },
    );

    await runWithInteractionTrace(
      other,
      () => h.tool.execute('kitchen-light'),
    );

    const record = await other.finish('succeeded');

    expect(record.spans).toEqual([]);
  });

  it('preserves normal execution without a trace', async () => {
    const h = harness();

    await expect(
      h.tool.execute('kitchen-light'),
    ).resolves.toMatchObject({
      status: 'resolved',
    });

    expect(h.execute).toHaveBeenCalledTimes(1);
  });
});
