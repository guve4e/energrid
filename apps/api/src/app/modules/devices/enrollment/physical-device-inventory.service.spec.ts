import { PhysicalDeviceInventoryService } from './physical-device-inventory.service';

describe('PhysicalDeviceInventoryService', () => {
  const scope = { tenantId: 'tenant-a', siteId: 'site-a' };
  const boilerOven = {
    scope,
    identity: { namespace: 'shelly-mqtt', value: 'shelly-proem-123' },
    evidenceSource: 'mqtt_protocol',
    observedAt: '2026-10-19T12:00:00.000Z',
    endpoint: { protocol: 'mqtt', kind: 'telemetry', address: 'shelly/boiler@oven' },
    components: [
      { key: 'em1:0', capabilities: ['power'] },
      { key: 'em1:1', capabilities: ['power'] },
    ],
  };

  function harness() {
    const repository = {
      discover: jest.fn(async (input: typeof boilerOven) => ({
        physicalDeviceId: 'physical-1',
        status: 'discovered' as const,
        components: input.components,
        endpoints: [input.endpoint],
        lastSeenAt: input.observedAt,
      })),
      associateNetworkObservation: jest.fn(),
      assignComponent: jest.fn(),
      discoverLanIdentity: jest.fn().mockResolvedValue({
        physicalDeviceId: 'physical-manual',
        verificationStatus: 'user_confirmed',
        networkObservations: [{ ipAddress: '192.168.1.133', verificationStatus: 'user_confirmed' }],
      }),
      refreshNetworkObservations: jest.fn(),
      get: jest.fn(),
      list: jest.fn(),
    };
    const enrollment = { find: jest.fn().mockResolvedValue({ status: 'enrolled' }) };
    const service = new PhysicalDeviceInventoryService(repository as never, enrollment as never, () => '2026-10-19T12:00:01.000Z');
    return { repository, enrollment, service };
  }

  it('proposes one physical device with two protocol-identified components without enrolling either', async () => {
    const { repository, service } = harness();
    const proposal = await service.discover(boilerOven);

    expect(proposal).toMatchObject({
      physicalDeviceId: 'physical-1',
      status: 'discovered',
      components: [{ key: 'em1:0' }, { key: 'em1:1' }],
    });
    expect(repository.discover).toHaveBeenCalledWith(boilerOven);
    expect(proposal).not.toHaveProperty('enrollment');
  });

  it('does not use a communication prefix as the physical identity', async () => {
    const { repository, service } = harness();
    await service.discover(boilerOven);
    await service.discover({
      ...boilerOven,
      endpoint: { ...boilerOven.endpoint, address: 'new-prefix/telemetry' },
      observedAt: '2026-10-19T12:00:15.000Z',
    });

    expect(repository.discover).toHaveBeenCalledTimes(2);
    expect(repository.discover.mock.calls[1][0].identity).toEqual(boilerOven.identity);
  });

  it('rejects IP-only input as a durable identity claim', async () => {
    const { repository, service } = harness();
    await expect(service.discover({
      ...boilerOven,
      identity: { namespace: 'ip', value: '192.168.1.204' },
    })).rejects.toThrow('Stable protocol identity evidence is required');
    expect(repository.discover).not.toHaveBeenCalled();
  });

  it('rejects duplicate component identities in one protocol report', async () => {
    const { repository, service } = harness();
    await expect(service.discover({
      ...boilerOven,
      components: [boilerOven.components[0], boilerOven.components[0]],
    })).rejects.toThrow('Component keys must be unique');
    expect(repository.discover).not.toHaveBeenCalled();
  });

  it('rejects credential-bearing endpoint addresses before persistence', async () => {
    const { repository, service } = harness();
    await expect(service.discover({
      ...boilerOven,
      endpoint: { protocol: 'http', kind: 'rpc', address: 'http://operator:secret@192.168.1.204/rpc' },
    })).rejects.toThrow('Communication endpoint evidence is invalid');
    expect(repository.discover).not.toHaveBeenCalled();
  });

  it('associates a LAN observation only after enrollment and records it as user confirmed', async () => {
    const { repository, service } = harness();
    await service.associateLanIdentity({
      device: { ...scope, deviceId: 'temp-kitchen' },
      networkScope: 'gateway-home:iot',
      ipAddress: '192.168.1.133',
      observedAt: '2026-10-19T12:00:00.000Z',
      evidenceSource: 'lan_discovery',
      actor: 'portal-operator',
    });
    expect(repository.discoverLanIdentity).toHaveBeenCalledWith(expect.objectContaining({
      networkScope: 'gateway-home:iot',
      device: { ...scope, deviceId: 'temp-kitchen' },
      associatedBy: 'portal-operator',
    }));
  });

  it('normalizes a user-confirmed but not hardware-verified MAC claim', async () => {
    const { repository, service } = harness();
    await service.associateLanIdentity({
      device: { ...scope, deviceId: 'temp-kitchen' }, networkScope: 'gateway-home:iot',
      ipAddress: '192.168.1.133', macAddress: 'a:b:c:d:e:f',
      observedAt: '2026-10-19T12:00:00.000Z', evidenceSource: 'lan_discovery', actor: 'portal-operator',
    });
    expect(repository.discoverLanIdentity.mock.calls[0][0].macAddress).toBe('0a:0b:0c:0d:0e:0f');
    expect(repository.discoverLanIdentity.mock.calls[0][0]).not.toHaveProperty('hardwareVerifiedAt');
  });

  it('does not make an IP-only observation a durable protocol identity', async () => {
    const { repository, service } = harness();
    await service.associateLanIdentity({
      device: { ...scope, deviceId: 'temp-kitchen' },
      networkScope: 'gateway-home:iot',
      ipAddress: '192.168.1.133',
      observedAt: '2026-10-19T12:00:00.000Z',
      evidenceSource: 'lan_discovery',
      actor: 'portal-operator',
    });
    expect(repository.discoverLanIdentity.mock.calls[0][0]).not.toHaveProperty('macAddress');
    expect(repository.discover).not.toHaveBeenCalled();
  });

  it('rejects an association for a device that is not enrolled', async () => {
    const { repository } = harness();
    const enrollment = { find: jest.fn().mockResolvedValue(null) };
    const service = new PhysicalDeviceInventoryService(repository as never, enrollment as never);
    await expect(service.associateLanIdentity({
      device: { ...scope, deviceId: 'unknown' }, networkScope: 'gateway-home:iot',
      ipAddress: '192.168.1.133', observedAt: '2026-10-19T12:00:00.000Z',
      evidenceSource: 'lan_discovery', actor: 'portal-operator',
    })).rejects.toThrow('Enrolled device was not found');
    expect(repository.discoverLanIdentity).not.toHaveBeenCalled();
  });
});
