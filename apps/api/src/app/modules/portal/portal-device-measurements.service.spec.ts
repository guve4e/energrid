import { BadRequestException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { PortalDeviceMeasurementsService } from './portal-device-measurements.service';

const scope = { tenantId: 'tenant-home', siteId: 'site-home' };
const deviceId = 'device:upstream-lan:esp8266:324864';
const current = { deviceId, freshnessLimitSeconds: 60, fields: {
  temperature: { value: 18.2, sourceId: 'energrid-http-status', receivedAt: '2026-10-24T10:00:00.000Z', ageSeconds: 3, freshness: 'fresh', authority: 'approved' },
  humidity: { value: 49, sourceId: 'energrid-http-status', receivedAt: '2026-10-24T10:00:00.000Z', ageSeconds: 3, freshness: 'fresh', authority: 'approved' },
} };

function harness() {
  const intelligence = {
    describeDevice: jest.fn().mockResolvedValue({ deviceId, displayName: 'Kitchen DHT22' }),
    readObservations: jest.fn().mockResolvedValue(current),
  };
  const repository = { read: jest.fn().mockResolvedValue([
    { observedAt: '2026-10-24T09:05:00.000Z', value: 18, unit: 'Cel', quality: 'measured' },
    { observedAt: '2026-10-24T09:55:00.000Z', value: 18.2, unit: 'Cel', quality: 'measured' },
  ]) };
  return { service: new PortalDeviceMeasurementsService(intelligence as never, repository as never), intelligence, repository };
}

describe('PortalDeviceMeasurementsService', () => {
  const to = new Date(Date.now() - 60_000).toISOString();
  const from = new Date(Date.parse(to) - 60 * 60_000).toISOString();

  it('returns latest Core observations with Core freshness, not PostgreSQL history', async () => {
    const h = harness();
    await expect(h.service.current(scope, deviceId)).resolves.toEqual(current);
    expect(h.intelligence.readObservations).toHaveBeenCalledWith(scope, deviceId);
    expect(h.repository.read).not.toHaveBeenCalled();
  });

  it('queries only the requested tenant, site, device, metric, time range and bounded limit', async () => {
    const h = harness();
    await expect(h.service.history(scope, deviceId, 'temperature', from, to, '20')).resolves.toMatchObject({
      deviceId, metric: 'temperature', unit: 'Cel', measurements: [
        { observedAt: '2026-10-24T09:05:00.000Z', value: 18, unit: 'Cel' },
        { observedAt: '2026-10-24T09:55:00.000Z', value: 18.2, unit: 'Cel' },
      ],
    });
    expect(h.repository.read).toHaveBeenCalledWith({
      ...scope, deviceId, componentId: 'device', channel: 'temperature', metric: 'temperature', from, to, limit: 20,
    });
  });

  it('keeps fresh, stale and unavailable Core states distinct', async () => {
    const h = harness();
    h.intelligence.readObservations.mockResolvedValueOnce({ ...current, fields: {
      temperature: { ...current.fields.temperature, freshness: 'stale' },
    } });
    await expect(h.service.current(scope, deviceId)).resolves.toMatchObject({
      fields: { temperature: { freshness: 'stale' } },
    });
    h.intelligence.readObservations.mockResolvedValueOnce(null);
    await expect(h.service.current(scope, deviceId)).resolves.toEqual({ deviceId, freshnessLimitSeconds: 60, fields: {} });
  });

  it('does not query history for an unauthorized or non-current metric', async () => {
    const h = harness();
    h.intelligence.readObservations.mockResolvedValue({ ...current, fields: {} });
    await expect(h.service.history(scope, deviceId, 'temperature', from, to)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(h.service.history(scope, deviceId, 'power', from, to)).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.repository.read).not.toHaveBeenCalled();
  });

  it('returns an empty history and canonical unit when no rows exist', async () => {
    const h = harness();
    h.repository.read.mockResolvedValue([]);
    await expect(h.service.history(scope, deviceId, 'humidity', from, to)).resolves.toMatchObject({
      metric: 'humidity', unit: '%RH', measurements: [],
    });
  });

  it('fails safely for unknown devices, invalid ranges, excessive limits and database outages', async () => {
    const h = harness();
    h.intelligence.describeDevice.mockResolvedValue(null);
    await expect(h.service.current(scope, deviceId)).rejects.toBeInstanceOf(NotFoundException);
    h.intelligence.describeDevice.mockResolvedValue({ deviceId, displayName: 'Kitchen' });
    await expect(h.service.history(scope, deviceId, 'temperature', to, from)).rejects.toBeInstanceOf(BadRequestException);
    await expect(h.service.history(scope, deviceId, 'temperature', from, to, '5001')).rejects.toBeInstanceOf(BadRequestException);
    h.repository.read.mockRejectedValue(new Error('database details must not escape'));
    await expect(h.service.history(scope, deviceId, 'temperature', from, to)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
