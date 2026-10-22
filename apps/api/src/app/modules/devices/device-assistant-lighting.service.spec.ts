import { DeviceAssistantLightingService } from './device-assistant-lighting.service';

const scope = { tenantId: 'tenant-demo', siteId: 'site-home' };
const deviceId = 'shelly-test:switch:0';
const envKey = 'HOME_ASSISTANT_INSTANT_LIGHT_DEVICE_IDS';
const originalEnv = process.env[envKey];

afterEach(() => {
  if (originalEnv === undefined) delete process.env[envKey];
  else process.env[envKey] = originalEnv;
});

function harness() {
  process.env[envKey] = deviceId;

  const device = {
    id: deviceId,
    tenantId: scope.tenantId,
    siteId: scope.siteId,
    kind: 'physical',
    trustStatus: 'approved',
    assistantEnabled: true,
    metadata: { loadType: 'lighting' },
    capabilities: [{ kind: 'switch' }],
    control: { binding: { enabled: true } },
  };

  const registry = {
    ensureInstallationsLoaded: jest.fn().mockResolvedValue(undefined),
    getDevices: jest.fn().mockReturnValue([device]),
  };

  const installations = {
    get: jest.fn().mockResolvedValue({
      schemaVersion: 1,
      device: structuredClone(device),
    }),
  };

  const enrollment = {
    find: jest.fn().mockResolvedValue({ status: 'enrolled' }),
  };

  const controls = {
    execute: jest.fn().mockResolvedValue({
      status: 'success',
      deviceId,
      action: 'turn_on',
    }),
  };

  const service = new DeviceAssistantLightingService(
    registry as unknown as ConstructorParameters<
      typeof DeviceAssistantLightingService
    >[0],
    installations as unknown as ConstructorParameters<
      typeof DeviceAssistantLightingService
    >[1],
    enrollment as unknown as ConstructorParameters<
      typeof DeviceAssistantLightingService
    >[2],
    controls as unknown as ConstructorParameters<
      typeof DeviceAssistantLightingService
    >[3],
  );

  return {
    service,
    device,
    registry,
    installations,
    enrollment,
    controls,
  };
}

describe('Core assistant lighting execution', () => {
  it('executes explicitly approved lighting without confirmation', async () => {
    const h = harness();

    const result = await h.service.execute(
      scope, deviceId, 'turn_on',
    );

    expect(result).toMatchObject({
      status: 'confirmed',
      deviceId,
      action: 'turn_on',
      confirmation: 'none',
    });
    expect(h.controls.execute).toHaveBeenCalledWith(
      deviceId, 'turn_on',
    );
  });

  it('does not claim success for an unconfirmed command', async () => {
    const h = harness();
    h.controls.execute.mockResolvedValue({ status: 'pending' });

    const result = await h.service.execute(
      scope, deviceId, 'turn_on',
    );

    expect(result.status).toBe('not_confirmed');
  });

  it('denies execution without explicit opt-in', async () => {
    const h = harness();
    delete process.env[envKey];

    const result = await h.service.execute(
      scope, deviceId, 'turn_on',
    );

    expect(result).toMatchObject({
      status: 'denied',
      reason: 'instant_control_not_enabled',
    });
    expect(h.controls.execute).not.toHaveBeenCalled();
  });

  it('denies execution outside the authorized scope', async () => {
    const h = harness();

    const result = await h.service.execute(
      { ...scope, siteId: 'another-house' },
      deviceId,
      'turn_on',
    );

    expect(result.status).toBe('denied');
    expect(h.controls.execute).not.toHaveBeenCalled();
  });

  it('denies devices without durable enrollment', async () => {
    const h = harness();
    h.enrollment.find.mockResolvedValue(null);

    const result = await h.service.execute(
      scope, deviceId, 'turn_on',
    );

    expect(result).toMatchObject({
      status: 'denied',
      reason: 'device_not_enrolled',
    });
    expect(h.controls.execute).not.toHaveBeenCalled();
  });

  it('denies assistant-disabled installations', async () => {
    const h = harness();
    const installation = await h.installations.get();
    installation.device.assistantEnabled = false;

    const result = await h.service.execute(
      scope, deviceId, 'turn_on',
    );

    expect(result).toMatchObject({
      status: 'denied',
      reason: 'installation_policy_mismatch',
    });
    expect(h.controls.execute).not.toHaveBeenCalled();
  });

  it('denies devices not classified as lighting', async () => {
    const h = harness();
    const installation = await h.installations.get();
    installation.device.metadata.loadType = 'heating';

    const result = await h.service.execute(
      scope, deviceId, 'turn_on',
    );

    expect(result.status).toBe('denied');
    expect(h.controls.execute).not.toHaveBeenCalled();
  });

  it('denies disabled persisted control routes', async () => {
    const h = harness();
    const installation = await h.installations.get();
    installation.device.control.binding.enabled = false;

    const result = await h.service.execute(
      scope, deviceId, 'turn_on',
    );

    expect(result.status).toBe('denied');
    expect(h.controls.execute).not.toHaveBeenCalled();
  });

  it('denies ambiguous device identities', async () => {
    const h = harness();
    h.registry.getDevices.mockReturnValue([h.device, h.device]);

    const result = await h.service.execute(
      scope, deviceId, 'turn_on',
    );

    expect(result).toMatchObject({
      status: 'denied',
      reason: 'ambiguous_device',
    });
    expect(h.controls.execute).not.toHaveBeenCalled();
  });
});

describe('Durable interaction traces for lighting', () => {
  afterEach(() => jest.restoreAllMocks());

  it('records successful command and physical execution spans', async () => {
    const { FileInteractionTraceStore } = await import(
      '../observability/file-interaction-trace.store'
    );

    const records: unknown[] = [];

    jest.spyOn(FileInteractionTraceStore.prototype, 'save')
      .mockImplementation(async record => {
        records.push(record);
      });

    const h = harness();
    const result = await h.service.executeTraced(
      scope, deviceId, 'turn_on',
    );

    expect(result.status).toBe('confirmed');
    expect(result.traceId).toBeTruthy();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      traceId: result.traceId,
      origin: 'chat',
      outcome: 'succeeded',
      spans: expect.arrayContaining([
        expect.objectContaining({
          stage: 'core.command',
          outcome: 'ok',
        }),
        expect.objectContaining({
          stage: 'device.execute',
          outcome: 'ok',
        }),
      ]),
    });
  });

  it('records a denied command without operating hardware', async () => {
    const { FileInteractionTraceStore } = await import(
      '../observability/file-interaction-trace.store'
    );

    const records: Array<{ outcome: string }> = [];

    jest.spyOn(FileInteractionTraceStore.prototype, 'save')
      .mockImplementation(async record => {
        records.push(record);
      });

    const h = harness();
    delete process.env[envKey];

    const result = await h.service.executeTraced(
      scope, deviceId, 'turn_on',
    );

    expect(result.status).toBe('denied');
    expect(records[0].outcome).toBe('denied');
    expect(h.controls.execute).not.toHaveBeenCalled();
  });

  it('preserves successful control if trace storage fails', async () => {
    const { FileInteractionTraceStore } = await import(
      '../observability/file-interaction-trace.store'
    );

    jest.spyOn(FileInteractionTraceStore.prototype, 'save')
      .mockRejectedValue(new Error('Disk unavailable'));

    const h = harness();

    const result = await h.service.executeTraced(
      scope, deviceId, 'turn_on',
    );

    expect(result.status).toBe('confirmed');
    expect(h.controls.execute).toHaveBeenCalledTimes(1);
  });
});

describe('Lighting execution within a parent conversation trace', () => {
  it('reuses the parent trace without persisting a second record', async () => {
    const { InteractionTraceSession } = await import(
      '../observability/interaction-trace'
    );
    const { runWithInteractionTrace } = await import(
      '../observability/interaction-trace-context'
    );
    const { FileInteractionTraceStore } = await import(
      '../observability/file-interaction-trace.store'
    );

    const separateSave = jest.spyOn(
      FileInteractionTraceStore.prototype,
      'save',
    );

    try {
      const save = jest.fn().mockResolvedValue(undefined);
      const trace = new InteractionTraceSession(
        scope,
        'chat',
        { save },
      );

      const h = harness();

      const result = await runWithInteractionTrace(
        trace,
        () => h.service.executeTraced(
          scope,
          deviceId,
          'turn_on',
        ),
      );

      expect(result.status).toBe('confirmed');
      expect(result.traceId).toBe(trace.traceId);
      expect(save).not.toHaveBeenCalled();

      const record = await trace.finish('succeeded');

      expect(save).toHaveBeenCalledTimes(1);
      expect(record.spans.map(span => span.stage)).toEqual(
        expect.arrayContaining([
          'core.command',
          'device.execute',
        ]),
      );
      expect(separateSave).not.toHaveBeenCalled();
    } finally {
      separateSave.mockRestore();
    }
  });
});
