import { MongoClient } from 'mongodb';
import { LegacyMongoPowerAdapter } from './legacy-mongo-power.adapter';
import { LegacyPowerConfig } from './legacy-power.config';

const query = {
  from: '2026-01-01T00:00:00.000Z',
  to: '2026-01-01T00:05:00.000Z',
};
const binding = {
  id: 'boiler',
  displayName: 'Boiler',
  tenantId: 'tenant',
  siteId: 'site',
  sourceDeviceId: 'legacy-boiler',
  timezone: 'Europe/Sofia',
  activeThresholdW: 500,
};
const config: LegacyPowerConfig = {
  uri: 'private-uri',
  database: 'mqtt',
  bindings: [binding],
};
function mockClient(rows: object[] = []) {
  const cursor = {
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    toArray: jest.fn().mockResolvedValue(rows),
  };
  const collection = {
    find: jest.fn().mockReturnValue(cursor),
    findOne: jest.fn().mockResolvedValue(null),
  };
  const db = { collection: jest.fn().mockReturnValue(collection) };
  const client = {
    db: jest.fn().mockReturnValue(db),
    close: jest.fn().mockResolvedValue(undefined),
  };
  return {
    client,
    collection,
    cursor,
    db,
    adapter: new LegacyMongoPowerAdapter(
      config,
      client as unknown as MongoClient,
    ),
  };
}
describe('read-only Mongo history adapter', () => {
  it('uses a device/type/time bound, projection, sort, timeout and limit', async () => {
    const mock = mockClient([
      { timestamp: new Date(query.from), value: { value: 0 }, unit: 'W' },
    ]);
    const result = await mock.adapter.read('boiler', query);
    expect(mock.client.db).toHaveBeenCalledWith('mqtt');
    expect(mock.db.collection).toHaveBeenCalledWith('devicereadings');
    expect(mock.collection.find).toHaveBeenCalledWith(
      {
        deviceId: 'legacy-boiler',
        type: 'power',
        timestamp: { $gte: new Date(query.from), $lt: new Date(query.to) },
      },
      expect.objectContaining({
        maxTimeMS: 10000,
        projection: { _id: 0, timestamp: 1, value: 1, unit: 1 },
      }),
    );
    expect(mock.cursor.sort).toHaveBeenCalledWith({ timestamp: 1 });
    expect(mock.cursor.limit).toHaveBeenCalledWith(100001);
    expect(result.observations).toEqual([
      { observedAt: query.from, powerW: 0 },
    ]);
    expect(result).not.toHaveProperty('documents');
  });
  it('loads nearby boundary readings for clipped integration', async () => {
    const mock = mockClient();
    const before = new Date(Date.parse(query.from) - 60000),
      after = new Date(Date.parse(query.to) + 60000);
    mock.collection.findOne
      .mockResolvedValueOnce({ timestamp: before, value: 1000 })
      .mockResolvedValueOnce({ timestamp: after, value: 0 });
    const result = await mock.adapter.read('boiler', query);
    expect(result.observations).toHaveLength(2);
    expect(mock.collection.findOne.mock.calls[0][0].timestamp).toEqual({
      $lt: new Date(query.from),
      $gte: new Date(Date.parse(query.from) - 300000),
    });
    expect(mock.collection.findOne.mock.calls[1][0].timestamp).toEqual({
      $gte: new Date(query.to),
      $lte: new Date(Date.parse(query.to) + 300000),
    });
  });
  it('retains value failures as breaks and counts unusable timestamps', async () => {
    const mock = mockClient([
      { timestamp: new Date(query.from), value: null },
      { timestamp: 'invalid', value: 1000 },
    ]);
    const result = await mock.adapter.read('boiler', query);
    expect(result.rejectedReadings).toBe(1);
    expect(result.observations).toEqual([
      { observedAt: query.from, powerW: null },
    ]);
  });
  it('refuses oversized data instead of silently returning a truncated total', async () => {
    const mock = mockClient(Array(100001).fill({}));
    await expect(mock.adapter.read('boiler', query)).rejects.toThrow(
      'shorter period',
    );
  });
  it('sanitizes database errors', async () => {
    const mock = mockClient();
    mock.collection.findOne.mockRejectedValue(
      new Error('mongodb://user:secret@private-host'),
    );
    await expect(mock.adapter.read('boiler', query)).rejects.toThrow(
      'database connection',
    );
    await expect(mock.adapter.read('boiler', query)).rejects.not.toThrow(
      'secret',
    );
  });
  it('does not read unassigned devices', async () => {
    const mock = mockClient();
    await expect(mock.adapter.read('unknown', query)).rejects.toThrow(
      'not configured',
    );
    expect(mock.client.db).not.toHaveBeenCalled();
  });
  it('can be installed without a configured database', async () => {
    const adapter = new LegacyMongoPowerAdapter({ ...config, uri: null }, null);
    await expect(adapter.read('boiler', query)).rejects.toThrow(
      'not configured',
    );
    await expect(adapter.onModuleDestroy()).resolves.toBeUndefined();
  });
  it('closes its own connection at shutdown', async () => {
    const mock = mockClient();
    await mock.adapter.onModuleDestroy();
    expect(mock.client.close).toHaveBeenCalledTimes(1);
  });
});
