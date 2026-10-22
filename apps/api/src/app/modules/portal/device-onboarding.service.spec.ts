import type { DeviceRegistryService } from '../devices/device-registry.service';
import type { DeviceEnrollmentService } from '../devices/enrollment/device-enrollment.service';
import type { RegisteredDevice } from '../devices/device-registry.types';

import { DeviceOnboardingService } from './device-onboarding.service';

const identity = {
  tenantId: 'tenant-demo',
  siteId: 'site-home',
  deviceId: 'temp-kitchen',
};

function createHarness(
  physicalInventory?: unknown,
  initialMetadata: Record<string, string | number | boolean> = {},
  deviceId = identity.deviceId,
  protocol: 'mqtt' | 'http' = 'mqtt',
) {
  const candidateIdentity = { ...identity, deviceId };
  let current = {
    ...candidateIdentity,
    id: deviceId,
    displayName: 'Kitchen Temperature',
    trustStatus: 'discovered',
    state: { values: {}, observedAt: '2026-10-19T12:00:00.000Z', source: 'mqtt', status: 'online' },
    adapter: { protocol, transport: protocol, driver: initialMetadata.httpBaseUrl ? 'shelly-lan' : protocol, configured: true },
    capabilities: [{ kind: initialMetadata.component === 'switch:0' ? 'switch' : 'power', actions: ['read'] }],
    metadata: initialMetadata,
  } as unknown as RegisteredDevice;

  const registry = {
    getSnapshot: jest.fn(() => ({
      tenant: { id: identity.tenantId },
      site: { id: identity.siteId },
    })),

    getDevices: jest.fn(() => [current]),

    setEnrollmentStatus: jest.fn(),

    approveDiscoveredDevice: jest.fn(() => {
      current = {
        ...current,
        trustStatus: 'approved',
        metadata: {
          ...current.metadata,
          approvedFromDiscovery: true,
        },
      };

      return current;
    }),

    persistInstallation: jest.fn(async () => {
      current = {
        ...current,
        commissioning: {
          physicalOutcome: 'not_confirmed',
          confirmedAt: null,
        },
      };
    }),
  };

  const enrollment = {
    find: jest.fn().mockResolvedValue(null),

    enroll: jest.fn().mockResolvedValue({
      ...candidateIdentity,
      status: 'enrolled',
      version: 1,
    }),
    reenroll: jest.fn().mockResolvedValue({ ...candidateIdentity, status: 'enrolled', version: 2 }),
  };

  const service = new DeviceOnboardingService(
    registry as unknown as DeviceRegistryService,
    enrollment as unknown as DeviceEnrollmentService,
    physicalInventory as never,
  );

  return {
    service,
    registry,
    enrollment,
  };
}

describe('DeviceOnboardingService', () => {
  it('explicitly reenrolls a retired discovery candidate after fresh evidence makes it pending', async () => {
    const { service, registry, enrollment } = createHarness(undefined, {
      mqttEvidenceCandidate: true,
      previouslyEnrolledRetired: true,
    });
    enrollment.find.mockResolvedValue({ ...identity, status: 'retired', displayName: 'Kitchen Temperature' } as any);

    await service.approve(identity.deviceId);

    expect(enrollment.enroll).not.toHaveBeenCalled();
    expect(enrollment.reenroll).toHaveBeenCalledWith(
      identity,
      'Kitchen Temperature',
      'portal-control-token',
    );
    expect(registry.setEnrollmentStatus).toHaveBeenCalledWith(identity.deviceId, 'enrolled');
  });

  it('persists installation before enrollment', async () => {
    const { service, registry, enrollment } = createHarness();

    await service.approve(identity.deviceId);

    expect(registry.approveDiscoveredDevice)
      .toHaveBeenCalledTimes(1);

    expect(registry.persistInstallation)
      .toHaveBeenCalledTimes(1);

    expect(enrollment.enroll)
      .toHaveBeenCalledWith(
        {
          ...identity,
          displayName: 'Kitchen Temperature',
        },
        'portal-control-token',
      );

    expect(
      registry.persistInstallation.mock.invocationCallOrder[0],
    ).toBeLessThan(
      enrollment.enroll.mock.invocationCallOrder[0],
    );
  });

  it('onboards a LAN-verified Shelly Plus 1 through the existing installation and enrollment stores', async () => {
    const deviceId = 'shellyplus1-8813bfcdc8bc:switch:0';
    const physicalInventory = {
      discover: jest.fn().mockResolvedValue({ physicalDeviceId: 'physical-plus1' }),
      forLogicalDevice: jest.fn().mockResolvedValue(null),
      associateLanIdentity: jest.fn().mockResolvedValue(undefined),
      assignComponent: jest.fn().mockResolvedValue(undefined),
    };
    const { service, registry, enrollment } = createHarness(physicalInventory, {
      physicalId: 'shellyplus1-8813bfcdc8bc',
      component: 'switch:0',
      httpBaseUrl: 'http://192.168.1.220',
      ipAddress: '192.168.1.220',
      networkScope: 'gateway-unknown:home-lan',
      networkObservedAt: '2026-10-22T12:00:00.000Z',
      macAddress: '88:13:bf:cd:c8:bc',
    }, deviceId, 'http');

    await service.approve(deviceId);

    expect(registry.approveDiscoveredDevice).toHaveBeenCalledWith(deviceId);
    expect(registry.persistInstallation).toHaveBeenCalledWith(expect.objectContaining({
      id: deviceId,
      adapter: expect.objectContaining({ protocol: 'http', driver: 'shelly-lan' }),
    }), true);
    expect(enrollment.enroll).toHaveBeenCalledWith({
      tenantId: identity.tenantId,
      siteId: identity.siteId,
      deviceId,
      displayName: 'Kitchen Temperature',
    }, 'portal-control-token');
    expect(physicalInventory.discover).toHaveBeenCalledWith(expect.objectContaining({
      identity: { namespace: 'mqtt:shelly-protocol-id', value: 'shellyplus1-8813bfcdc8bc' },
      evidenceSource: 'lan_discovery_protocol_match',
      components: [{ key: 'switch:0', capabilities: ['switch'] }],
      endpoint: { protocol: 'http', kind: 'rpc', address: 'http://192.168.1.220' },
    }));
    expect(physicalInventory.associateLanIdentity).toHaveBeenCalledWith(expect.objectContaining({
      ipAddress: '192.168.1.220', macAddress: '88:13:bf:cd:c8:bc',
      evidenceSource: 'lan_discovery_protocol_match',
    }));
    expect(registry.setEnrollmentStatus).toHaveBeenCalledWith(deviceId, 'enrolled');
  });

  it('persists a protocol-identified component only as part of explicit onboarding approval', async () => {
    const physicalInventory = {
      forLogicalDevice: jest.fn().mockResolvedValue(null),
      discover: jest.fn().mockResolvedValue({
        physicalDeviceId: 'physical-proem',
        components: [{ key: 'em1:0', capabilities: ['power'] }],
      }),
      assignComponent: jest.fn().mockResolvedValue({ physicalDeviceId: 'physical-proem' }),
      associateLanIdentity: jest.fn().mockResolvedValue({ physicalDeviceId: 'physical-proem' }),
    };
    const { service, enrollment } = createHarness(physicalInventory, {
      physicalId: 'shellypro3em-001122334455',
      component: 'em1:0',
    });

    await service.approve(identity.deviceId);

    expect(enrollment.enroll).toHaveBeenCalledTimes(1);
    expect(physicalInventory.discover).toHaveBeenCalledWith(expect.objectContaining({
      identity: { namespace: 'mqtt:shelly-protocol-id', value: 'shellypro3em-001122334455' },
      components: [expect.objectContaining({ key: 'em1:0' })],
    }));
    expect(physicalInventory.assignComponent).toHaveBeenCalledWith(expect.objectContaining({
      device: identity,
      physicalDeviceId: 'physical-proem',
      componentKey: 'em1:0',
      actor: 'portal-control-token',
    }));
  });

  it('persists scoped LAN evidence only after the user approves the protocol candidate', async () => {
    const physicalInventory = {
      forLogicalDevice: jest.fn().mockResolvedValue(null),
      discover: jest.fn().mockResolvedValue({ physicalDeviceId: 'physical-proem' }),
      associateLanIdentity: jest.fn().mockResolvedValue({ physicalDeviceId: 'physical-proem' }),
      assignComponent: jest.fn().mockResolvedValue({ physicalDeviceId: 'physical-proem' }),
    };
    const { service, enrollment } = createHarness(physicalInventory, {
      physicalId: 'shellypro3em-001122334455',
      component: 'em1:0',
      httpBaseUrl: 'http://192.168.1.204',
      ipAddress: '192.168.1.204',
      macAddress: '00:11:22:33:44:55',
      hostname: 'shelly-proem',
      gatewayId: 'gateway-home',
      networkScope: 'gateway-home:home',
      networkObservedAt: '2026-10-19T12:00:00.000Z',
    });

    await service.approve(identity.deviceId);

    expect(enrollment.enroll).toHaveBeenCalledTimes(1);
    expect(physicalInventory.discover).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: { protocol: 'http', kind: 'rpc', address: 'http://192.168.1.204' },
    }));
    expect(physicalInventory.associateLanIdentity).toHaveBeenCalledWith(expect.objectContaining({
      device: identity,
      physicalDeviceId: 'physical-proem',
      ipAddress: '192.168.1.204',
      macAddress: '00:11:22:33:44:55',
      evidenceSource: 'lan_discovery_protocol_match',
      actor: 'portal-control-token',
    }));
  });

  it('reenrolls retired hardware only through explicit Discovery approval', async () => {
    const { service, enrollment, registry } = createHarness();
    enrollment.find.mockResolvedValue({ ...identity, status: 'retired', version: 3 });

    await service.approve(identity.deviceId);

    expect(enrollment.enroll).not.toHaveBeenCalled();
    expect(enrollment.reenroll).toHaveBeenCalledWith(
      identity,
      'Kitchen Temperature',
      'portal-control-token',
    );
    expect(registry.approveDiscoveredDevice).toHaveBeenCalledTimes(1);
  });

  it('never enrolls when installation persistence fails', async () => {
    const { service, registry, enrollment } = createHarness();

    registry.persistInstallation.mockRejectedValueOnce(
      new Error('Installation storage unavailable'),
    );

    await expect(
      service.approve(identity.deviceId),
    ).rejects.toThrow('Installation storage unavailable');

    expect(enrollment.enroll).not.toHaveBeenCalled();
  });

  it('can retry after PostgreSQL enrollment fails', async () => {
    const { service, registry, enrollment } = createHarness();

    enrollment.enroll.mockRejectedValueOnce(
      new Error('PostgreSQL temporarily unavailable'),
    );

    await expect(
      service.approve(identity.deviceId),
    ).rejects.toThrow('PostgreSQL temporarily unavailable');

    // The installation succeeded, but enrollment did not.
    expect(registry.persistInstallation)
      .toHaveBeenCalledTimes(1);

    expect(enrollment.enroll)
      .toHaveBeenCalledTimes(1);

    // Retrying completes the missing PostgreSQL operation.
    await expect(
      service.approve(identity.deviceId),
    ).resolves.toMatchObject({
      id: identity.deviceId,
      trustStatus: 'approved',
    });

    expect(registry.persistInstallation)
      .toHaveBeenCalledTimes(1);

    expect(enrollment.enroll)
      .toHaveBeenCalledTimes(2);
  });

  it('does not enroll a suspended device again', async () => {
    const { service, registry, enrollment } = createHarness();

    enrollment.find.mockResolvedValue({
      ...identity,
      status: 'suspended',
    });

    await expect(
      service.approve(identity.deviceId),
    ).rejects.toThrow('Suspended enrollment');

    expect(registry.approveDiscoveredDevice)
      .not.toHaveBeenCalled();

    expect(enrollment.enroll)
      .not.toHaveBeenCalled();
  });

  it('rejects devices outside the active site', async () => {
    const { service, registry, enrollment } = createHarness();

    registry.getSnapshot.mockReturnValue({
      tenant: { id: identity.tenantId },
      site: { id: 'another-site' },
    });

    await expect(
      service.approve(identity.deviceId),
    ).rejects.toThrow('Device candidate not found');

    expect(enrollment.enroll)
      .not.toHaveBeenCalled();
  });

  it('does not duplicate an existing enrollment', async () => {
    const { service, registry, enrollment } = createHarness();

    await service.approve(identity.deviceId);

    enrollment.find.mockResolvedValue({
      ...identity,
      status: 'enrolled',
      version: 1,
    });

    await service.approve(identity.deviceId);

    expect(enrollment.enroll)
      .toHaveBeenCalledTimes(1);

    expect(registry.persistInstallation)
      .toHaveBeenCalledTimes(1);
  });
});
