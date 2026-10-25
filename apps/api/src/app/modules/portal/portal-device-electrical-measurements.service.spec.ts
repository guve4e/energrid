import { PortalDeviceElectricalMeasurementsService } from './portal-device-electrical-measurements.service';

const now = new Date('2026-10-24T12:00:00.000Z');
const baseDevice = {
  id: 'relay-meter', tenantId: 'tenant-a', siteId: 'site-a', kind: 'physical', trustStatus: 'approved',
  supportedCapabilities: [{ kind: 'power', actions: ['read'] }], capabilities: [{ kind: 'power', actions: ['read'] }],
  metadata: { component: 'em1:0' },
};
function setup(device: Record<string, unknown> = baseDevice) {
  const registry = { getSnapshot: () => ({ tenant: { id: 'tenant-a' }, site: { id: 'site-a' } }), getDevices: () => [device] };
  const telemetry = { read: jest.fn().mockResolvedValue([{ quality: 'measured', value: 128.4, unit: 'W', observedAt: now.toISOString() }]) };
  return { service: new PortalDeviceElectricalMeasurementsService(registry as never, telemetry as never), telemetry };
}
const range = [new Date(now.getTime() - 60_000).toISOString(), now.toISOString()] as const;

describe('PortalDeviceElectricalMeasurementsService', () => {
  afterEach(() => jest.restoreAllMocks());
  it('serves readings only for approved, scoped devices with an authorized power capability', async () => {
    const { service, telemetry } = setup();
    await expect(service.history('relay-meter', 'power', ...range)).resolves.toMatchObject({ metric: 'power', measurements: [{ value: 128.4, unit: 'W' }] });
    expect(telemetry.read).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-a', siteId: 'site-a', channel: 'em1:0', metric: 'power' }), ...range);
  });
  it.each([
    ['wrong site', { ...baseDevice, siteId: 'site-b' }],
    ['unapproved', { ...baseDevice, trustStatus: 'discovered' }],
  ])('does not read telemetry for %s', async (_label, device) => {
    const { service, telemetry } = setup(device as Record<string, unknown>);
    await expect(service.history('relay-meter', 'power', ...range)).rejects.toThrow();
    expect(telemetry.read).not.toHaveBeenCalled();
  });
  it('distinguishes supported from unauthorized power readings', async () => {
    const { service, telemetry } = setup({ ...baseDevice, capabilities: [] });
    await expect(service.history('relay-meter', 'power', ...range)).rejects.toThrow('not authorized');
    expect(telemetry.read).not.toHaveBeenCalled();
  });
  it('does not expose electrical history for a relay-only device', async () => {
    const relay = { ...baseDevice, supportedCapabilities: [{ kind: 'switch', actions: ['turn_on', 'turn_off'] }], capabilities: [{ kind: 'switch', actions: ['turn_on', 'turn_off'] }] };
    const { service, telemetry } = setup(relay);
    await expect(service.history('relay-meter', 'power', ...range)).rejects.toThrow('no verified electrical');
    expect(telemetry.read).not.toHaveBeenCalled();
  });
});
