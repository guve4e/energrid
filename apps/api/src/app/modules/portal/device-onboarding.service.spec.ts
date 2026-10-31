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
    adapter: {
      protocol, transport: protocol, driver: initialMetadata.httpBaseUrl ? 'shelly-lan' : protocol,
      configured: true,
      ...(typeof initialMetadata.httpBaseUrl === 'string'
        ? { target: `${initialMetadata.httpBaseUrl}/api/v1/status` }
        : {}),
    },
    capabilities: [{ kind: initialMetadata.component === 'switch:0' ? 'switch' : 'power', actions: ['read'] }],
    metadata: {
      discoveryTenantId: identity.tenantId,
      discoverySiteId: identity.siteId,
      ...initialMetadata,
    },
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
  it('rejects a candidate whose verified discovery owner differs from the authorized site', async () => {
    const { service, registry, enrollment } = createHarness(undefined, {
      discoverySiteId: 'site-virtual-lab',
    });

    await expect(service.approve(identity.deviceId)).rejects.toThrow(
      'Discovery evidence ownership does not match the authorized tenant and site',
    );
    expect(registry.approveDiscoveredDevice).not.toHaveBeenCalled();
    expect(registry.persistInstallation).not.toHaveBeenCalled();
    expect(enrollment.enroll).not.toHaveBeenCalled();
  });

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
      'portal-admin',
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
        'portal-admin',
      );

    expect(
      registry.persistInstallation.mock.invocationCallOrder[0],
    ).toBeLessThan(
      enrollment.enroll.mock.invocationCallOrder[0],
    );
  });

  it('enrolls a candidate into the operator-selected room while retaining the active tenant and site scope', async () => {
    const { service, registry, enrollment } = createHarness();
    await service.approve(identity.deviceId, { zoneId: 'office', zoneName: 'Office' });
    expect(registry.approveDiscoveredDevice).toHaveBeenCalledWith(identity.deviceId, {
      zoneId: 'office', zoneName: 'Office',
    });
    expect(enrollment.enroll).toHaveBeenCalledWith({
      ...identity, displayName: 'Kitchen Temperature',
    }, 'portal-admin');
  });

  it('onboards a LAN-verified Shelly Plus 1 through the existing installation and enrollment stores', async () => {
    const deviceId = 'shellyplus1-8813bfcdc8bc:switch:0';
    const verifiedAt = new Date().toISOString();
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
      identityEvidenceSource: 'verified_shelly_http_rpc',
      identityVerificationMethod: 'GET /rpc/Shelly.GetDeviceInfo',
      identityVerifiedAt: verifiedAt,
      componentEvidenceSource: 'verified_shelly_component_status_rpc',
      componentVerificationMethod: 'Switch.GetStatus?id=0',
      componentVerifiedAt: verifiedAt,
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
    }, 'portal-admin');
    expect(physicalInventory.discover).toHaveBeenCalledWith(expect.objectContaining({
      identity: { namespace: 'mqtt:shelly-protocol-id', value: 'shellyplus1-8813bfcdc8bc' },
      evidenceSource: 'lan_discovery_protocol_match',
      components: [{ key: 'switch:0', capabilities: ['switch'] }],
      endpoint: { protocol: 'http', kind: 'rpc', address: 'http://192.168.1.220' },
    }));
    expect(physicalInventory.associateLanIdentity).toHaveBeenCalledWith(expect.objectContaining({
      physicalDeviceId: 'physical-plus1',
      ipAddress: '192.168.1.220', macAddress: '88:13:bf:cd:c8:bc',
      evidenceSource: 'lan_discovery_protocol_match',
    }));
    expect(registry.getDevices()[0].capabilities).toEqual([{ kind: 'switch', actions: ['read'] }]);
    expect(registry.getDevices()[0].capabilities.flatMap(capability => capability.actions || []))
      .not.toEqual(expect.arrayContaining(['turn_on', 'turn_off']));
    expect(registry.getDevices()[0].metadata).not.toHaveProperty('measurementApproval');
    expect(registry.getDevices()[0].metadata).not.toHaveProperty('controlBinding');
    expect(registry.setEnrollmentStatus).toHaveBeenCalledWith(deviceId, 'enrolled');
  });

  it('rejects malformed Shelly MAC evidence before installation or enrollment persists', async () => {
    const deviceId = 'shellyplus1-00c0de000001:switch:0';
    const { service, registry, enrollment } = createHarness(undefined, {
      physicalId: 'shellyplus1-00c0de000001', component: 'switch:0',
      identityEvidenceSource: 'verified_shelly_http_rpc', identityVerificationMethod: 'GET /rpc/Shelly.GetDeviceInfo',
      identityVerifiedAt: new Date().toISOString(),
      componentEvidenceSource: 'verified_shelly_component_status_rpc',
      componentVerificationMethod: 'Switch.GetStatus?id=0', componentVerifiedAt: new Date().toISOString(),
      httpBaseUrl: 'http://172.30.250.11',
      macAddress: '02C0DE00000Z', ipAddress: '172.30.250.11', networkScope: 'virtual-lab',
      networkObservedAt: new Date().toISOString(),
    }, deviceId, 'http');

    await expect(service.approve(deviceId)).rejects.toThrow('LAN MAC evidence is invalid');
    expect(registry.approveDiscoveredDevice).not.toHaveBeenCalled();
    expect(registry.persistInstallation).not.toHaveBeenCalled();
    expect(enrollment.enroll).not.toHaveBeenCalled();
  });

  it('retries a partial Shelly enrollment idempotently after inventory association fails', async () => {
    const deviceId = 'shellyplus1-00c0de000001:switch:0';
    const physicalDeviceId = '3e709572-76c5-4d5f-8c89-ec23a8d7c55b';
    let assignedPhysicalDeviceId: string | undefined;
    const physicalInventory = {
      forLogicalDevice: jest.fn(async () => assignedPhysicalDeviceId
        ? { physicalDeviceId: assignedPhysicalDeviceId }
        : null),
      discover: jest.fn().mockResolvedValue({ physicalDeviceId }),
      associateLanIdentity: jest.fn()
        .mockRejectedValueOnce(new Error('temporary inventory write failure'))
        .mockImplementation(async input => {
          assignedPhysicalDeviceId = input.physicalDeviceId;
          return { physicalDeviceId } as any;
        }),
      assignComponent: jest.fn().mockResolvedValue({ physicalDeviceId }),
    };
    const { service, registry, enrollment } = createHarness(physicalInventory, {
      physicalId: 'shellyplus1-00c0de000001', component: 'switch:0',
      httpBaseUrl: 'http://172.30.250.11', ipAddress: '172.30.250.11',
      networkScope: 'virtual-device-lab', networkObservedAt: new Date().toISOString(),
      macAddress: '02C0DE000001',
      identityEvidenceSource: 'verified_shelly_http_rpc', identityVerificationMethod: 'GET /rpc/Shelly.GetDeviceInfo',
      identityVerifiedAt: new Date().toISOString(),
      componentEvidenceSource: 'verified_shelly_component_status_rpc',
      componentVerificationMethod: 'Switch.GetStatus?id=0', componentVerifiedAt: new Date().toISOString(),
    }, deviceId, 'http');
    enrollment.find.mockImplementation(async () => enrollment.enroll.mock.calls.length
      ? { ...identity, deviceId, status: 'enrolled', version: 1 } as any
      : null);
    enrollment.enroll.mockResolvedValue({ ...identity, deviceId, status: 'enrolled', version: 1 } as any);

    await expect(service.approve(deviceId)).rejects.toThrow('temporary inventory write failure');
    expect(enrollment.enroll).toHaveBeenCalledTimes(1);
    expect(registry.persistInstallation).toHaveBeenCalledTimes(1);

    await expect(service.approve(deviceId)).resolves.toMatchObject({
      id: deviceId, trustStatus: 'approved',
    });
    await service.approve(deviceId);

    expect(enrollment.enroll).toHaveBeenCalledTimes(1);
    expect(registry.persistInstallation).toHaveBeenCalledTimes(1);
    expect(physicalInventory.discover).toHaveBeenCalledTimes(3);
    expect(physicalInventory.discover.mock.calls.every(call =>
      call[0].identity.value === 'shellyplus1-00c0de000001')).toBe(true);
    expect(physicalInventory.discover.mock.calls.map(call => call[0].physicalDeviceId))
      .toEqual([undefined, undefined, physicalDeviceId]);
    expect(physicalInventory.associateLanIdentity).toHaveBeenLastCalledWith(expect.objectContaining({
      physicalDeviceId,
      macAddress: '02C0DE000001',
    }));
    expect(physicalInventory.assignComponent).toHaveBeenLastCalledWith(expect.objectContaining({
      physicalDeviceId, componentKey: 'switch:0',
    }));
    expect(registry.getDevices()[0].capabilities).toEqual([{ kind: 'switch', actions: ['read'] }]);
    expect(registry.getDevices()[0].capabilities.flatMap(capability => capability.actions || []))
      .not.toEqual(expect.arrayContaining(['turn_on', 'turn_off']));
    expect(registry.getDevices()[0].metadata).not.toHaveProperty('measurementApproval');
    expect(registry.getDevices()[0].metadata).not.toHaveProperty('controlBinding');
  });

  it('does not overwrite a conflicting physical identity during partial-enrollment retry', async () => {
    const deviceId = 'shellyplus1-00c0de000001:switch:0';
    const physicalInventory = {
      forLogicalDevice: jest.fn().mockResolvedValue(null),
      discover: jest.fn()
        .mockResolvedValueOnce({ physicalDeviceId: '3e709572-76c5-4d5f-8c89-ec23a8d7c55b' })
        .mockRejectedValue(new Error('Physical identity is already associated with another device')),
      associateLanIdentity: jest.fn().mockRejectedValue(new Error('temporary inventory write failure')),
      assignComponent: jest.fn(),
    };
    const { service, enrollment, registry } = createHarness(physicalInventory, {
      physicalId: 'shellyplus1-00c0de000001', component: 'switch:0',
      httpBaseUrl: 'http://172.30.250.11',
      identityEvidenceSource: 'verified_shelly_http_rpc', identityVerificationMethod: 'GET /rpc/Shelly.GetDeviceInfo',
      identityVerifiedAt: new Date().toISOString(),
      componentEvidenceSource: 'verified_shelly_component_status_rpc',
      componentVerificationMethod: 'Switch.GetStatus?id=0', componentVerifiedAt: new Date().toISOString(),
      macAddress: '02C0DE000001', ipAddress: '172.30.250.11', networkScope: 'virtual-device-lab',
      networkObservedAt: new Date().toISOString(),
    }, deviceId, 'http');
    enrollment.find.mockImplementation(async () => enrollment.enroll.mock.calls.length
      ? { ...identity, deviceId, status: 'enrolled', version: 1 } as any
      : null);
    await expect(service.approve(deviceId)).rejects.toThrow('temporary inventory write failure');
    await expect(service.approve(deviceId)).rejects.toThrow('Physical identity is already associated with another device');
    expect(enrollment.enroll).toHaveBeenCalledTimes(1);
    expect(registry.persistInstallation).toHaveBeenCalledTimes(1);
    expect(physicalInventory.assignComponent).not.toHaveBeenCalled();
  });

  it('records Energrid firmware identity and the observed IP in existing physical inventory only after enrollment', async () => {
    const physicalInventory = {
      discover: jest.fn().mockResolvedValue({ physicalDeviceId: 'physical-esp8266' }),
      forLogicalDevice: jest.fn().mockResolvedValue(null),
      associateLanIdentity: jest.fn().mockResolvedValue(undefined),
      assignComponent: jest.fn(),
    };
    const deviceId = 'device:upstream-lan:esp8266:324864';
    const metadata = {
      physicalId: 'esp8266:324864', identityEvidenceSource: 'bounded GET /api/v1/identity',
      httpBaseUrl: 'http://192.168.1.198',
      firmwareVersion: '0.2.0', ipAddress: '192.168.1.198', networkScope: 'upstream-lan',
      networkObservedAt: '2026-10-23T12:14:20.245Z',
    };
    const { service, enrollment } = createHarness(physicalInventory, metadata, deviceId, 'http');
    await service.approve(deviceId, { zoneId: 'office', zoneName: 'Office' });
    expect(enrollment.enroll).toHaveBeenCalledTimes(1);
    expect(physicalInventory.discover).toHaveBeenCalledWith(expect.objectContaining({
      identity: { namespace: 'energrid:firmware-device-id:upstream-lan', value: 'esp8266:324864' },
      evidenceSource: 'bounded_http_identity', components: [],
      endpoint: { protocol: 'http', kind: 'status', address: 'http://192.168.1.198/api/v1/status' },
    }));
    expect(physicalInventory.associateLanIdentity).toHaveBeenCalledWith(expect.objectContaining({
      physicalDeviceId: 'physical-esp8266', ipAddress: '192.168.1.198', networkScope: 'upstream-lan',
    }));
    expect(physicalInventory.assignComponent).not.toHaveBeenCalled();
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
      httpBaseUrl: 'http://192.168.1.204',
      identityEvidenceSource: 'verified_shelly_http_rpc',
      identityVerificationMethod: 'GET /rpc/Shelly.GetDeviceInfo',
      identityVerifiedAt: new Date().toISOString(),
      componentEvidenceSource: 'verified_shelly_component_status_rpc',
      componentVerificationMethod: 'EM1.GetStatus?id=0',
      componentVerifiedAt: new Date().toISOString(),
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
      actor: 'portal-admin',
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
      identityEvidenceSource: 'verified_shelly_http_rpc',
      identityVerificationMethod: 'GET /rpc/Shelly.GetDeviceInfo',
      identityVerifiedAt: new Date().toISOString(),
      componentEvidenceSource: 'verified_shelly_component_status_rpc',
      componentVerificationMethod: 'EM1.GetStatus?id=0',
      componentVerifiedAt: new Date().toISOString(),
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
      actor: 'portal-admin',
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
      'portal-admin',
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

  it('rejects MQTT-only Shelly identity claims before enrollment', async () => {
    const deviceId = 'shellypro2pm-aabbccddeeff:switch:0';
    const { service, registry, enrollment } = createHarness(undefined, {
      physicalId: 'shellypro2pm-aabbccddeeff',
      component: 'switch:0',
      mqttCommandTopic: 'shellypro2pm-aabbccddeeff/rpc',
      mqttEvidenceCandidate: true,
    }, deviceId);
    await expect(service.approve(deviceId)).rejects.toThrow('Fresh Shelly LAN identity');
    expect(registry.approveDiscoveredDevice).not.toHaveBeenCalled();
    expect(registry.persistInstallation).not.toHaveBeenCalled();
    expect(enrollment.enroll).not.toHaveBeenCalled();
  });

  it('rejects Shelly candidates whose verified LAN evidence is older than fifteen minutes', async () => {
    const deviceId = 'shellypro2pm-aabbccddeeff:switch:1';
    const stale = new Date(Date.now() - 16 * 60_000).toISOString();
    const { service, registry, enrollment } = createHarness(undefined, {
      physicalId: 'shellypro2pm-aabbccddeeff', component: 'switch:1',
      identityEvidenceSource: 'verified_shelly_http_rpc',
      identityVerificationMethod: 'GET /rpc/Shelly.GetDeviceInfo', identityVerifiedAt: stale,
      componentEvidenceSource: 'verified_shelly_component_status_rpc',
      componentVerificationMethod: 'Switch.GetStatus?id=1', componentVerifiedAt: stale,
    }, deviceId, 'http');
    await expect(service.approve(deviceId)).rejects.toThrow('Fresh Shelly LAN identity');
    expect(registry.approveDiscoveredDevice).not.toHaveBeenCalled();
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

  it('offers recovery only for the exact enrolled, same-site Shelly component with a unique unassigned physical record', async () => {
    const physicalId = 'shellyplus1-00c0de000001';
    const componentKey = 'switch:0';
    const deviceId = `${physicalId}:${componentKey}`;
    const verifiedAt = new Date().toISOString();
    const device = {
      id: deviceId, tenantId: 'tenant-demo', siteId: 'site-virtual-lab', kind: 'physical',
      trustStatus: 'approved',
      adapter: { driver: 'shelly-lan' },
      metadata: {
        approvedFromDiscovery: true, discoveryTenantId: 'tenant-demo', discoverySiteId: 'site-virtual-lab',
        physicalId, component: componentKey, identityEvidenceSource: 'verified_shelly_http_rpc',
        componentEvidenceSource: 'verified_shelly_component_status_rpc',
        identityVerificationMethod: 'GET /rpc/Shelly.GetDeviceInfo', identityVerifiedAt: verifiedAt,
        componentVerificationMethod: 'Switch.GetStatus?id=0', componentVerifiedAt: verifiedAt,
      },
    } as unknown as RegisteredDevice;
    const physical = {
      physicalDeviceId: '3e709572-76c5-4d5f-8c89-ec23a8d7c55b',
      scope: { tenantId: 'tenant-demo', siteId: 'site-virtual-lab' },
      identity: { namespace: 'mac', value: '02:c0:de:00:00:01' },
      identities: [
        { namespace: 'mac', value: '02:c0:de:00:00:01' },
        { namespace: 'mqtt:shelly-protocol-id', value: physicalId },
      ],
      components: [{ key: componentKey, capabilities: ['switch'] }], assignments: [],
    };
    const registry = {
      getSnapshot: jest.fn(() => ({ tenant: { id: 'tenant-demo' }, site: { id: 'site-virtual-lab' } })),
      getDevices: jest.fn(() => [device]),
    };
    const enrollment = { find: jest.fn().mockResolvedValue({ status: 'enrolled' }) };
    const inventory = {
      forLogicalDevice: jest.fn().mockResolvedValue(null),
      list: jest.fn().mockResolvedValue([physical]),
    };
    const service = new DeviceOnboardingService(
      registry as unknown as DeviceRegistryService,
      enrollment as unknown as DeviceEnrollmentService,
      inventory as never,
    );

    await expect(service.getShellyIdentityRecovery(deviceId)).resolves.toEqual({
      status: 'ready',
      reason: 'Fresh identity and component evidence is available for the existing association.',
      physicalDeviceId: physical.physicalDeviceId, physicalId, componentKey,
    });
    expect(enrollment.find).toHaveBeenCalledWith({ tenantId: 'tenant-demo', siteId: 'site-virtual-lab', deviceId });
  });

  it('requires selected-device verification after existing identity evidence expires', async () => {
    const physicalId = 'shellyplus1-00c0de000001';
    const componentKey = 'switch:0';
    const deviceId = `${physicalId}:${componentKey}`;
    const stale = '2026-10-30T00:00:00.000Z';
    const device = {
      id: deviceId, tenantId: 'tenant-demo', siteId: 'site-virtual-lab', kind: 'physical', trustStatus: 'approved',
      adapter: { driver: 'shelly-lan' },
      metadata: { approvedFromDiscovery: true, discoveryTenantId: 'tenant-demo', discoverySiteId: 'site-virtual-lab',
        physicalId, component: componentKey, identityEvidenceSource: 'verified_shelly_http_rpc',
        componentEvidenceSource: 'verified_shelly_component_status_rpc',
        identityVerificationMethod: 'GET /rpc/Shelly.GetDeviceInfo', identityVerifiedAt: stale,
        componentVerificationMethod: 'Switch.GetStatus?id=0', componentVerifiedAt: stale },
    } as unknown as RegisteredDevice;
    const physical = { physicalDeviceId: 'physical-plus1', scope: { tenantId: 'tenant-demo', siteId: 'site-virtual-lab' },
      identity: { namespace: 'mqtt:shelly-protocol-id', value: physicalId }, components: [{ key: componentKey }], assignments: [] };
    const service = new DeviceOnboardingService(
      { getSnapshot: () => ({ tenant: { id: 'tenant-demo' }, site: { id: 'site-virtual-lab' } }), getDevices: () => [device] } as unknown as DeviceRegistryService,
      { find: jest.fn().mockResolvedValue({ status: 'enrolled' }) } as unknown as DeviceEnrollmentService,
      { forLogicalDevice: jest.fn().mockResolvedValue(null), list: jest.fn().mockResolvedValue([physical]) } as never,
    );
    await expect(service.getShellyIdentityRecovery(deviceId)).resolves.toMatchObject({
      status: 'verification_required', physicalDeviceId: 'physical-plus1', physicalId, componentKey,
    });
  });

  it('does not offer recovery for another site or an existing assignment', async () => {
    const physicalId = 'shellyplus1-00c0de000001';
    const componentKey = 'switch:0';
    const deviceId = `${physicalId}:${componentKey}`;
    const device = {
      id: deviceId, tenantId: 'tenant-demo', siteId: 'site-virtual-lab', kind: 'physical', trustStatus: 'approved',
      adapter: { driver: 'shelly-lan' }, metadata: { approvedFromDiscovery: true, discoveryTenantId: 'tenant-demo',
        discoverySiteId: 'site-home', physicalId, component: componentKey },
    } as unknown as RegisteredDevice;
    const linked = { physicalDeviceId: 'physical-plus1', assignments: [{ deviceId, physicalDeviceId: 'physical-plus1', componentKey }] };
    const service = new DeviceOnboardingService(
      { getSnapshot: () => ({ tenant: { id: 'tenant-demo' }, site: { id: 'site-virtual-lab' } }), getDevices: () => [device] } as unknown as DeviceRegistryService,
      { find: jest.fn().mockResolvedValue({ status: 'enrolled' }) } as unknown as DeviceEnrollmentService,
      { forLogicalDevice: jest.fn().mockResolvedValue(linked), list: jest.fn() } as never,
    );
    await expect(service.getShellyIdentityRecovery(deviceId)).resolves.toMatchObject({ status: 'not_recoverable' });
  });

  it('offers idempotent recovery for a same-record assignment whose component key is missing', async () => {
    const physicalId = 'shellyplus1-00c0de000001';
    const componentKey = 'switch:0';
    const deviceId = `${physicalId}:${componentKey}`;
    const verifiedAt = new Date().toISOString();
    const physical = {
      physicalDeviceId: '3e709572-76c5-4d5f-8c89-ec23a8d7c55b',
      scope: { tenantId: 'tenant-demo', siteId: 'site-virtual-lab' },
      identity: { namespace: 'mqtt:shelly-protocol-id', value: physicalId },
      identities: [
        { namespace: 'mac', value: '02:c0:de:00:00:01' },
        { namespace: 'mqtt:shelly-protocol-id', value: physicalId },
      ],
      components: [{ key: componentKey, capabilities: ['switch'] }],
      assignments: [{ deviceId, physicalDeviceId: '3e709572-76c5-4d5f-8c89-ec23a8d7c55b' }],
    };
    const device = {
      id: deviceId, tenantId: 'tenant-demo', siteId: 'site-virtual-lab', kind: 'physical', trustStatus: 'approved',
      adapter: { driver: 'shelly-lan' },
      metadata: { approvedFromDiscovery: true, discoveryTenantId: 'tenant-demo', discoverySiteId: 'site-virtual-lab',
        physicalId, component: componentKey, identityEvidenceSource: 'verified_site_local_shelly_rpc',
        componentEvidenceSource: 'verified_site_local_shelly_rpc', siteLocalObserverId: 'virtual-observer',
        identityVerificationMethod: 'GET /rpc/Shelly.GetDeviceInfo', identityVerifiedAt: verifiedAt,
        componentVerificationMethod: 'Switch.GetStatus?id=0', componentVerifiedAt: verifiedAt },
    } as unknown as RegisteredDevice;
    const service = new DeviceOnboardingService(
      { getSnapshot: () => ({ tenant: { id: 'tenant-demo' }, site: { id: 'site-virtual-lab' } }), getDevices: () => [device] } as unknown as DeviceRegistryService,
      { find: jest.fn().mockResolvedValue({ status: 'enrolled' }) } as unknown as DeviceEnrollmentService,
      { forLogicalDevice: jest.fn().mockResolvedValue(physical), list: jest.fn().mockResolvedValue([physical]) } as never,
    );
    await expect(service.getShellyIdentityRecovery(deviceId)).resolves.toMatchObject({
      status: 'ready', physicalDeviceId: physical.physicalDeviceId, physicalId, componentKey,
    });
  });

  it('rejects a physical record that also contains a conflicting Shelly protocol identity', async () => {
    const physicalId = 'shellyplus1-00c0de000001';
    const componentKey = 'switch:0';
    const deviceId = `${physicalId}:${componentKey}`;
    const verifiedAt = new Date().toISOString();
    const device = {
      id: deviceId, tenantId: 'tenant-demo', siteId: 'site-virtual-lab', kind: 'physical', trustStatus: 'approved',
      adapter: { driver: 'shelly-lan' }, metadata: {
        approvedFromDiscovery: true, discoveryTenantId: 'tenant-demo', discoverySiteId: 'site-virtual-lab',
        physicalId, component: componentKey, identityEvidenceSource: 'verified_shelly_http_rpc',
        componentEvidenceSource: 'verified_shelly_component_status_rpc',
        identityVerificationMethod: 'GET /rpc/Shelly.GetDeviceInfo', identityVerifiedAt: verifiedAt,
        componentVerificationMethod: 'Switch.GetStatus?id=0', componentVerifiedAt: verifiedAt,
      },
    } as unknown as RegisteredDevice;
    const physical = {
      physicalDeviceId: '3e709572-76c5-4d5f-8c89-ec23a8d7c55b',
      scope: { tenantId: 'tenant-demo', siteId: 'site-virtual-lab' },
      identity: { namespace: 'mac', value: '02:c0:de:00:00:01' },
      identities: [
        { namespace: 'mac', value: '02:c0:de:00:00:01' },
        { namespace: 'mqtt:shelly-protocol-id', value: physicalId },
        { namespace: 'mqtt:shelly-protocol-id', value: 'shellyplus1-different-device' },
      ],
      components: [{ key: componentKey, capabilities: ['switch'] }], assignments: [],
    };
    const service = new DeviceOnboardingService(
      { getSnapshot: () => ({ tenant: { id: 'tenant-demo' }, site: { id: 'site-virtual-lab' } }), getDevices: () => [device] } as unknown as DeviceRegistryService,
      { find: jest.fn().mockResolvedValue({ status: 'enrolled' }) } as unknown as DeviceEnrollmentService,
      { forLogicalDevice: jest.fn().mockResolvedValue(null), list: jest.fn().mockResolvedValue([physical]) } as never,
    );
    await expect(service.getShellyIdentityRecovery(deviceId)).resolves.toMatchObject({
      status: 'not_recoverable', reason: 'The physical inventory record has conflicting Shelly protocol identities.',
    });
  });
});
