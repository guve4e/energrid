import { DeviceIntelligenceObservationIngress } from './device-intelligence-observation-ingress';
import { resolveInstallationObservationAuthority } from './device-observation-installation-authority';
import type { DeviceInstallationRecord } from './device-installation.store';

const scope = {
  tenantId: 'tenant-a',
  siteId: 'site-a',
};

const deviceId = 'kitchen-switch';
const sourceId = 'shelly-http';
const selector = 'switch:0';

function installation(
  overrides: Record<string, unknown> = {},
): DeviceInstallationRecord {
  return {
    schemaVersion: 1,
    device: {
      id: deviceId,
      tenantId: scope.tenantId,
      siteId: scope.siteId,
      trustStatus: 'approved',
      kind: 'physical',
    },
    observationAuthority: {
      bindings: [{
        deviceId,
        sourceId,
        selector,
        fields: {
          on: { rawKey: 'output', type: 'boolean' },
          temperature: { rawKey: 'temperature', type: 'number' },
        },
      }],
      policy: {
        deviceId,
        allowedSourcesByField: {
          on: [sourceId],
          // temperature is deliberately NOT authorized.
        },
      },
    },
    ...overrides,
  } as unknown as DeviceInstallationRecord;
}

function harness() {
  const registry = {
    ensureInstallationsLoaded: jest.fn().mockResolvedValue(undefined),
    getDevices: jest.fn().mockReturnValue([{
      id: deviceId,
      tenantId: scope.tenantId,
      siteId: scope.siteId,
      trustStatus: 'approved',
      kind: 'physical',
    }]),
  };

  const installations = {
    get: jest.fn().mockResolvedValue(installation()),
  };

  const enrollment = {
    find: jest.fn().mockResolvedValue({
      deviceId,
      status: 'enrolled',
    }),
  };

  const store = {
    process: jest.fn().mockResolvedValue({
      accepted: true,
      stage: 'observation',
      reason: 'accepted',
      updatedKeys: ['on'],
      rejectedFields: [],
    }),
  };

  const ingress = new DeviceIntelligenceObservationIngress(
    registry as unknown as ConstructorParameters<
      typeof DeviceIntelligenceObservationIngress
    >[0],
    installations as unknown as ConstructorParameters<
      typeof DeviceIntelligenceObservationIngress
    >[1],
    enrollment as unknown as ConstructorParameters<
      typeof DeviceIntelligenceObservationIngress
    >[2],
    store as unknown as ConstructorParameters<
      typeof DeviceIntelligenceObservationIngress
    >[3],
  );

  const input = {
    scope,
    deviceId,
    sourceId,
    selector,
    payload: {
      output: true,
      temperature: 95,
    },
    evidenceId: 'verified-readback-1',
  };

  return {
    ingress,
    registry,
    installations,
    enrollment,
    store,
    input,
  };
}

describe('Installation observation authority', () => {
  it('resolves only explicitly authorized fields', () => {
    const result = resolveInstallationObservationAuthority(
      installation(),
      sourceId,
      selector,
    );

    expect(result).not.toBeNull();
    expect(Object.keys(result!.binding.fields)).toEqual(['on']);
    expect(result!.binding.fields.on).toEqual({
      rawKey: 'output',
      type: 'boolean',
    });
  });

  it('rejects an unauthorized source', () => {
    expect(resolveInstallationObservationAuthority(
      installation(),
      'unknown-http',
      selector,
    )).toBeNull();
  });

  it('rejects a different selector', () => {
    expect(resolveInstallationObservationAuthority(
      installation(),
      sourceId,
      'switch:1',
    )).toBeNull();
  });

  it('rejects absent observation approval', () => {
    expect(resolveInstallationObservationAuthority(
      installation({ observationAuthority: undefined }),
      sourceId,
      selector,
    )).toBeNull();
  });

  it('rejects a no-longer-approved installation', () => {
    const record = installation();
    record.device.trustStatus = 'pending';

    expect(resolveInstallationObservationAuthority(
      record,
      sourceId,
      selector,
    )).toBeNull();
  });

  it('rejects ambiguous duplicate bindings', () => {
    const record = installation();
    const authority = record.observationAuthority!;
    authority.bindings.push({
      ...authority.bindings[0],
    });

    expect(resolveInstallationObservationAuthority(
      record,
      sourceId,
      selector,
    )).toBeNull();
  });

  it('rejects a mismatched policy device ID', () => {
    const record = installation();
    record.observationAuthority!.policy.deviceId = 'different-device';

    expect(resolveInstallationObservationAuthority(
      record,
      sourceId,
      selector,
    )).toBeNull();
  });
});

describe('Device Intelligence observation ingress', () => {
  it('accepts approved evidence with the correct source and scope', async () => {
    const h = harness();

    const result = await h.ingress.ingest(h.input);

    expect(result).toMatchObject({
      outcome: 'processed',
      accepted: true,
      updatedKeys: ['on'],
    });

    expect(h.store.process).toHaveBeenCalledTimes(1);

    const [actualScope, actualDeviceId, request] =
      h.store.process.mock.calls[0];

    expect(actualScope).toEqual(scope);
    expect(actualDeviceId).toBe(deviceId);
    expect(request.binding.sourceId).toBe(sourceId);
    expect(Object.keys(request.binding.fields)).toEqual(['on']);
    expect(request.context.selector).toBe(selector);
    expect(request.context.evidenceId).toBe('verified-readback-1');
    expect(Number.isNaN(Date.parse(request.context.receivedAt))).toBe(false);
  });

  it('rejects a wrong tenant before persistence', async () => {
    const h = harness();

    const result = await h.ingress.ingest({
      ...h.input,
      scope: { ...scope, tenantId: 'other-tenant' },
    });

    expect(result).toMatchObject({
      outcome: 'rejected',
      reasonCode: 'device_not_approved',
    });
    expect(h.store.process).not.toHaveBeenCalled();
  });

  it('rejects a wrong site before persistence', async () => {
    const h = harness();

    const result = await h.ingress.ingest({
      ...h.input,
      scope: { ...scope, siteId: 'other-site' },
    });

    expect(result).toMatchObject({
      outcome: 'rejected',
      reasonCode: 'device_not_approved',
    });
    expect(h.store.process).not.toHaveBeenCalled();
  });

  it('rejects a device without durable enrollment', async () => {
    const h = harness();
    h.enrollment.find.mockResolvedValue(null);

    const result = await h.ingress.ingest(h.input);

    expect(result).toMatchObject({
      outcome: 'rejected',
      reasonCode: 'device_not_enrolled',
    });
    expect(h.store.process).not.toHaveBeenCalled();
  });

  it('rejects installation identity mismatches', async () => {
    const h = harness();
    const record = installation();
    record.device.tenantId = 'different-tenant';
    h.installations.get.mockResolvedValue(record);

    const result = await h.ingress.ingest(h.input);

    expect(result).toMatchObject({
      outcome: 'rejected',
      reasonCode: 'installation_not_approved',
    });
    expect(h.store.process).not.toHaveBeenCalled();
  });

  it('rejects missing observation authority', async () => {
    const h = harness();
    h.installations.get.mockResolvedValue(
      installation({ observationAuthority: undefined }),
    );

    const result = await h.ingress.ingest(h.input);

    expect(result).toMatchObject({
      outcome: 'rejected',
      reasonCode: 'observation_authority_missing',
    });
    expect(h.store.process).not.toHaveBeenCalled();
  });

  it('rejects an unauthorized observation source', async () => {
    const h = harness();

    const result = await h.ingress.ingest({
      ...h.input,
      sourceId: 'unapproved-source',
    });

    expect(result).toMatchObject({
      outcome: 'rejected',
      reasonCode: 'observation_authority_missing',
    });
    expect(h.store.process).not.toHaveBeenCalled();
  });

  it('does not turn an engine rejection into success', async () => {
    const h = harness();
    h.store.process.mockResolvedValue({
      accepted: false,
      stage: 'observation',
      reason: 'rejected',
      updatedKeys: [],
      rejectedFields: ['on'],
    });

    const result = await h.ingress.ingest(h.input);

    expect(result).toMatchObject({
      outcome: 'processed',
      accepted: false,
      updatedKeys: [],
      rejectedFields: ['on'],
    });
  });
});
