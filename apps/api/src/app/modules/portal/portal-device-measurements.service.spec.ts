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
    readAuthorizedMeasurementHistory: jest.fn().mockResolvedValue({
      status: 'available', deviceId, metric: 'temperature', unit: 'Cel', authorizedSources: ['approved-http-adapter'],
      measurements: [
        { observedAt: '2026-10-24T09:05:00.000Z', value: 18, unit: 'Cel', quality: 'measured' },
        { observedAt: '2026-10-24T09:55:00.000Z', value: 18.2, unit: 'Cel', quality: 'measured' },
      ],
    }),
    readDeviceModel: jest.fn().mockResolvedValue({
      installation: { status: 'enrolled', tenantId: scope.tenantId, siteId: scope.siteId },
      history: { authorizedMetrics: ['temperature', 'humidity'] },
      observationAuthorization: { bindings: [
        { sourceId: 'approved-temperature', fields: ['temperature'] },
        { sourceId: 'approved-humidity', fields: ['humidity'] },
      ] },
      identity: { id: deviceId },
    }),
    authorizedSourcesForMetric: jest.fn((model: { observationAuthorization: { bindings: Array<{ sourceId: string; fields: string[] }> } }, metric: string) =>
      [...new Set(model.observationAuthorization.bindings.filter(binding => binding.fields.includes(metric)).map(binding => binding.sourceId))],
    ),
  };
  const repository = {
    summarize: jest.fn().mockResolvedValue([
      { metric: 'temperature', count: 42, oldest: '2026-10-23T10:00:00.000Z', newest: '2026-10-24T10:00:00.000Z' },
    ]),
    read: jest.fn().mockResolvedValue([
    { observedAt: '2026-10-24T09:05:00.000Z', value: 18, unit: 'Cel', quality: 'measured' },
    { observedAt: '2026-10-24T09:55:00.000Z', value: 18.2, unit: 'Cel', quality: 'measured' },
  ]) };
  return { service: new PortalDeviceMeasurementsService(intelligence as never, repository as never), intelligence, repository };
}

describe('PortalDeviceMeasurementsService', () => {
  const to = new Date(Date.now() - 60_000).toISOString();
  const from = new Date(Date.parse(to) - 60 * 60_000).toISOString();

  it('adds retained-history availability only for authorized metrics', async () => {
    const h = harness();
    await expect(h.service.readModel(scope, deviceId)).resolves.toMatchObject({
      identity: { id: deviceId },
      history: {
        availability: 'available',
        streams: [
          { metric: 'temperature', status: 'available', count: 42 },
          { metric: 'humidity', status: 'empty' },
        ],
      },
    });
    expect(h.repository.summarize).toHaveBeenCalledWith({
      ...scope, deviceId,
      authorizedSourcesByMetric: {
        temperature: ['approved-temperature'],
        humidity: ['approved-humidity'],
      },
    });
  });

  it('reports history unavailable without changing live authorized observations', async () => {
    const h = harness();
    h.repository.summarize.mockRejectedValue(new Error('history database unavailable'));
    await expect(h.service.readModel(scope, deviceId)).resolves.toMatchObject({
      history: { availability: 'unavailable', streams: [{ status: 'unavailable' }, { status: 'unavailable' }] },
    });
  });

  it('keeps unknown measurement history distinct from empty or unauthorized history', async () => {
    const h = harness();
    h.intelligence.readDeviceModel.mockResolvedValue({
      installation: { status: 'enrolled' },
      history: { authorizedMetrics: ['custom_signal'] },
      observationAuthorization: { bindings: [] },
      identity: { id: deviceId },
    } as never);
    h.repository.summarize.mockResolvedValueOnce([]);
    await expect(h.service.readModel(scope, deviceId)).resolves.toMatchObject({
      history: { availability: 'unknown', streams: [{ metric: 'custom_signal', status: 'unknown' }] },
    });
    expect(h.repository.summarize).toHaveBeenCalledWith({
      ...scope, deviceId,
      authorizedSourcesByMetric: { custom_signal: [] },
    });
  });

  it('uses the canonical stored device id for a case-normalized history lookup', async () => {
    const h = harness();
    await h.service.readModel(scope, deviceId.toUpperCase());
    expect(h.repository.summarize).toHaveBeenCalledWith({
      ...scope, deviceId,
      authorizedSourcesByMetric: {
        temperature: ['approved-temperature'],
        humidity: ['approved-humidity'],
      },
    });
  });

  it('preserves a discovered device as not enrolled without querying measurement history', async () => {
    const h = harness();
    h.intelligence.readDeviceModel.mockResolvedValue({
      installation: { status: 'not_enrolled' },
      history: { authorizedMetrics: [], availability: 'not_available', streams: [] },
    } as never);
    await expect(h.service.readModel(scope, 'candidate')).resolves.toMatchObject({
      installation: { status: 'not_enrolled' },
      history: { availability: 'not_available' },
    });
    expect(h.repository.summarize).not.toHaveBeenCalled();
  });

  it('returns latest Core observations with Core freshness, not PostgreSQL history', async () => {
    const h = harness();
    await expect(h.service.current(scope, deviceId)).resolves.toEqual(current);
    expect(h.intelligence.readObservations).toHaveBeenCalledWith(scope, deviceId);
    expect(h.repository.read).not.toHaveBeenCalled();
  });

  it('preserves the Portal history response while delegating to the shared authorized measurement reader', async () => {
    const h = harness();
    h.intelligence.readObservations.mockResolvedValue(null);
    await expect(h.service.history(scope, deviceId, 'temperature', from, to, '20')).resolves.toMatchObject({
      deviceId, metric: 'temperature', unit: 'Cel', measurements: [
        { observedAt: '2026-10-24T09:05:00.000Z', value: 18, unit: 'Cel' },
        { observedAt: '2026-10-24T09:55:00.000Z', value: 18.2, unit: 'Cel' },
      ],
    });
    expect(h.intelligence.readAuthorizedMeasurementHistory).toHaveBeenCalledWith(
      scope, deviceId, 'temperature', from, to, 20,
    );
    expect(h.repository.read).not.toHaveBeenCalled();
    expect(h.intelligence.readObservations).not.toHaveBeenCalled();
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
    h.intelligence.readAuthorizedMeasurementHistory.mockResolvedValue({ status: 'unauthorized' } as never);
    await expect(h.service.history(scope, deviceId, 'temperature', from, to)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(h.service.history(scope, deviceId, 'power', from, to)).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.repository.read).not.toHaveBeenCalled();
  });

  it('denies wrong-site and mismatched-device read models before querying history', async () => {
    const h = harness();
    h.intelligence.readAuthorizedMeasurementHistory.mockResolvedValueOnce({ status: 'not_found' } as never)
      .mockResolvedValueOnce({ status: 'not_found' } as never);
    await expect(h.service.history({ ...scope, siteId: 'other-site' }, deviceId, 'temperature', from, to))
      .rejects.toBeInstanceOf(NotFoundException);
    await expect(h.service.history(scope, deviceId, 'temperature', from, to))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(h.repository.read).not.toHaveBeenCalled();
  });

  it('returns an empty history and canonical unit when no rows exist', async () => {
    const h = harness();
    h.intelligence.readAuthorizedMeasurementHistory.mockResolvedValue({
      status: 'available', deviceId, metric: 'humidity', unit: '%RH', authorizedSources: ['approved-http-adapter'], measurements: [],
    } as never);
    await expect(h.service.history(scope, deviceId, 'humidity', from, to)).resolves.toMatchObject({
      metric: 'humidity', unit: '%RH', measurements: [],
    });
  });

  it('fails safely for unknown devices, invalid ranges, excessive limits and database outages', async () => {
    const h = harness();
    h.intelligence.describeDevice.mockResolvedValue(null);
    await expect(h.service.current(scope, deviceId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(h.service.history(scope, deviceId, 'temperature', to, from)).rejects.toBeInstanceOf(BadRequestException);
    await expect(h.service.history(scope, deviceId, 'temperature', from, to, '5001')).rejects.toBeInstanceOf(BadRequestException);
    h.intelligence.readAuthorizedMeasurementHistory.mockResolvedValue({ status: 'unavailable' } as never);
    await expect(h.service.history(scope, deviceId, 'temperature', from, to)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
