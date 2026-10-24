import { EnergyService, parsePowerRange } from './energy.service';
import { EnergyController } from './energy.controller';
import type { LegacyPowerConfig } from './legacy-power.config';
import type { DeviceProxyRequest } from '../portal/portal-device-proxy.service';

const asset = {
  id: 'boiler',
  displayName: 'Boiler',
  tenantId: 'test-tenant',
  siteId: 'test-site',
  sourceDeviceId: 'old-boiler',
  timezone: 'Europe/Sofia',
  activeThresholdW: 500,
};
const query = {
  from: '2026-01-01T00:00:00.000Z',
  to: '2026-01-01T00:05:00.000Z',
};
const config: LegacyPowerConfig & { configured: boolean } = {
  configured: true,
  uri: 'secret-uri',
  database: 'mqtt',
  bindings: [
    asset,
    { ...asset, id: 'other-site', siteId: 'other-site' },
    { ...asset, id: 'other-tenant', tenantId: 'other-tenant' },
  ],
};
const history = () => ({
  read: jest.fn().mockResolvedValue({
    observations: [
      { observedAt: query.from, powerW: 3000 },
      { observedAt: query.to, powerW: 0 },
    ],
    rejectedReadings: 0,
    source: 'test-reader',
    timestampBasis: 'collector-received',
  }),
});
let saved: NodeJS.ProcessEnv;
beforeEach(() => {
  saved = { ...process.env };
  process.env.PORTAL_TENANT_ID = 'test-tenant';
  process.env.PORTAL_SITE_ID = 'test-site';
});
afterEach(() => {
  process.env = saved;
});

describe('energy application service', () => {
  it('returns only this tenant/site assignments with no URI or legacy device ID', () => {
    const result = new EnergyService(config, history()).assets();
    expect(result.configured).toBe(true);
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]).not.toHaveProperty('sourceDeviceId');
    expect(JSON.stringify(result)).not.toContain('secret-uri');
  });
  it('calculates a domain summary through the reader port', async () => {
    const reader = history();
    const result = await new EnergyService(config, reader).dashboard(
      'boiler',
      query.from,
      query.to,
    );
    expect(reader.read).toHaveBeenCalledWith('boiler', query);
    expect(result.summary.energyKwh).toBe(0.25);
    expect(result.summary.coveragePct).toBe(100);
    expect(result.timestampBasis).toBe('collector-received');
    expect(result.asset).not.toHaveProperty('sourceDeviceId');
  });
  it.each(['unknown', 'other-site', 'other-tenant'])(
    'does not query history for an unassigned asset %s',
    async (id) => {
      const reader = history();
      await expect(
        new EnergyService(config, reader).dashboard(id, query.from, query.to),
      ).rejects.toThrow('not assigned');
      expect(reader.read).not.toHaveBeenCalled();
    },
  );
  it('does not query history for an invalid range', async () => {
    const reader = history();
    await expect(
      new EnergyService(config, reader).dashboard(
        'boiler',
        'invalid',
        query.to,
      ),
    ).rejects.toThrow();
    expect(reader.read).not.toHaveBeenCalled();
  });
  it('preserves the no-data state', async () => {
    const reader = history();
    reader.read.mockResolvedValue({
      observations: [],
      rejectedReadings: 0,
      source: 'test',
      timestampBasis: 'collector-received',
    });
    expect(
      (
        await new EnergyService(config, reader).dashboard(
          'boiler',
          query.from,
          query.to,
        )
      ).summary.energyKwh,
    ).toBeNull();
  });
});

describe('power range validation', () => {
  it('accepts and normalizes UTC instants', () => {
    expect(
      parsePowerRange('2026-01-01T00:00:00Z', query.to, Date.parse(query.to)),
    ).toEqual(query);
  });
  it.each([
    [undefined, query.to],
    [['2026-01-01'], query.to],
    ['2026-01-01', query.to],
    [query.from, query.from],
    [query.to, query.from],
    ['2025-01-01T00:00:00Z', query.to],
    [query.from, 'invalid'],
    ['2026-01-01T00:00:00+02:00', query.to],
    ['2026-02-30T00:00:00Z', '2026-03-03T00:00:00Z'],
    ['2026-01-01T24:00:00Z', '2026-01-03T00:00:00Z'],
    [query.from, '2099-01-01T00:00:00Z'],
  ])(
    'rejects malformed, reversed, future or oversized ranges %j %j',
    (from, to) => {
      expect(() => parsePowerRange(from, to, Date.parse(query.to))).toThrow();
    },
  );
});

describe('read-only energy endpoints', () => {
  const request = (token?: string) =>
    ({
      headers: token ? { authorization: `Bearer ${token}` } : {},
      url: '/portal/energy/assets',
      ...(token === 'test-token' ? { user: { userId: 'u1', email: 'admin@example.test', name: 'Admin', role: 'admin', sessionId: 's1', sessionVersion: 0 } } : {}),
    }) as DeviceProxyRequest;
  it.each([undefined, 'wrong-token'])(
    'requires authorization for assets and history (%s)',
    (token) => {
      const service = new EnergyService(config, history());
      const controller = new EnergyController(service);
      expect(() => controller.assets(request(token))).toThrow();
      expect(() =>
        controller.history(request(token), 'boiler', query.from, query.to),
      ).toThrow();
    },
  );
  it('exposes canonical summaries after authorization', async () => {
    const controller = new EnergyController(
      new EnergyService(config, history()),
    );
    expect(controller.assets(request('test-token')).assets).toHaveLength(1);
    expect(
      (
        await controller.history(
          request('test-token'),
          'boiler',
          query.from,
          query.to,
        )
      ).method,
    ).toBe('power-step-estimate');
  });
});
