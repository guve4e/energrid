import { PortalDeviceElectricalMeasurementsService } from './portal-device-electrical-measurements.service';

const now = new Date('2026-10-24T12:00:00.000Z');
const baseDevice = {
  id: 'relay-meter', tenantId: 'tenant-a', siteId: 'site-a', kind: 'physical', trustStatus: 'approved',
  supportedCapabilities: [{ kind: 'power', actions: ['read'] }], capabilities: [{ kind: 'power', actions: ['read'] }],
  metadata: { component: 'em1:0' }, control: { status: 'read-only', binding: null }, assistantEnabled: false,
};
const range = [new Date(now.getTime() - 60_000).toISOString(), now.toISOString()] as const;

function setup(device = baseDevice) {
  const registry = {
    getSnapshot: () => ({ tenant: { id: 'tenant-a' }, site: { id: 'site-a' } }),
    getDevices: () => [device],
  };
  const measurements = {
    history: jest.fn().mockResolvedValue({ deviceId: device.id, metric: 'power', unit: 'W',
      from: range[0], to: range[1], measurements: [{ observedAt: now.toISOString(), value: 128.4, unit: 'W', quality: 'measured' }] }),
  };
  return { service: new PortalDeviceElectricalMeasurementsService(registry as never, measurements as never), registry, measurements, device };
}

describe('PortalDeviceElectricalMeasurementsService', () => {
  it('keeps the electrical chart contract while delegating to generic site-scoped measurement history', async () => {
    const h = setup();
    await expect(h.service.history('relay-meter', 'power', ...range)).resolves.toEqual({
      deviceId: 'relay-meter', metric: 'power', unit: 'W', from: range[0], to: range[1],
      measurements: [{ observedAt: now.toISOString(), value: 128.4, unit: 'W' }],
    });
    expect(h.measurements.history).toHaveBeenCalledWith(
      { tenantId: 'tenant-a', siteId: 'site-a' }, 'relay-meter', 'power', range[0], range[1], 5000,
    );
  });

  it.each([
    ['wrong site', { ...baseDevice, siteId: 'site-b' }],
    ['unapproved', { ...baseDevice, trustStatus: 'discovered' }],
  ])('rejects %s before querying generic history', async (_label, device) => {
    const h = setup(device as typeof baseDevice);
    await expect(h.service.history('relay-meter', 'power', ...range)).rejects.toThrow();
    expect(h.measurements.history).not.toHaveBeenCalled();
  });

  it('rejects unsupported capabilities and malformed component channels', async () => {
    const relay = { ...baseDevice, supportedCapabilities: [{ kind: 'switch', actions: ['turn_on'] }] };
    const noPower = setup(relay);
    await expect(noPower.service.history('relay-meter', 'power', ...range)).rejects.toThrow('no verified electrical');
    expect(noPower.measurements.history).not.toHaveBeenCalled();
    const malformed = setup({ ...baseDevice, metadata: { component: 'room-0' } });
    await expect(malformed.service.history('relay-meter', 'power', ...range)).rejects.toThrow('verified electrical channel');
    expect(malformed.measurements.history).not.toHaveBeenCalled();
  });

  it('rejects unsupported metrics and does not change relay or assistant permissions', async () => {
    const h = setup();
    const originalControl = structuredClone(h.device.control);
    await expect(h.service.history('relay-meter', 'temperature', ...range)).rejects.toThrow('supported electrical metric');
    expect(h.measurements.history).not.toHaveBeenCalled();
    expect(h.device.control).toEqual(originalControl);
    expect(h.device.assistantEnabled).toBe(false);
  });

  it('preserves chronological output and downsamples large series to the existing chart limit', async () => {
    const h = setup();
    const readings = Array.from({ length: 2401 }, (_, index) => ({
      observedAt: new Date(now.getTime() - (2400 - index) * 1000).toISOString(), value: index, unit: 'W', quality: 'measured',
    }));
    h.measurements.history.mockResolvedValueOnce({ deviceId: 'relay-meter', metric: 'power', unit: 'W',
      from: range[0], to: range[1], measurements: readings });
    const result = await h.service.history('relay-meter', 'power', ...range);
    expect(result.measurements.length).toBeLessThanOrEqual(1200);
    expect(Date.parse(result.measurements[0].observedAt)).toBeLessThan(Date.parse(result.measurements.at(-1)!.observedAt));
    expect(result.measurements.at(-1)?.value).toBe(2400);
  });
});
