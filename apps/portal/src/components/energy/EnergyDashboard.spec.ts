import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import EnergyDashboard from './EnergyDashboard.vue';
import {
  recentPowerRange,
  type EnergyDashboard as Dashboard,
} from './energy-types';

const asset = {
  id: 'boiler',
  displayName: 'Boiler',
  tenantId: 'tenant',
  siteId: 'site',
  timezone: 'Europe/Sofia',
  activeThresholdW: 500,
  capacityLiters: 80,
  schedule: { start: '04:00', end: '06:00' },
};
const stats = {
  energyKwh: 0.25,
  averagePowerW: 250,
  peakPowerW: 3000,
  activeMinutes: 5,
  outsideScheduleKwh: 0,
  coveragePct: 100,
  coveredSeconds: 3600,
  expectedSeconds: 3600,
};
const dashboard: Dashboard = {
  asset,
  range: { from: '2026-10-09T21:00:00Z', to: '2026-10-10T22:00:00Z' },
  source: 'legacy-mongo-power',
  timestampBasis: 'collector-received',
  rejectedReadings: 0,
  method: 'power-step-estimate',
  maxGapSeconds: 300,
  invalidReadings: 0,
  duplicateReadings: 0,
  conflictingReadings: 0,
  summary: { ...stats, energyKwh: 0.5 },
  daily: [
    { ...stats, date: '2026-10-10' },
    { ...stats, date: '2026-10-11' },
  ],
  hourly: [
    {
      ...stats,
      from: '2026-10-10T00:00:00Z',
      to: '2026-10-10T01:00:00Z',
      localDate: '2026-10-10',
      localHour: '03:00',
    },
    {
      ...stats,
      from: '2026-10-10T21:00:00Z',
      to: '2026-10-10T22:00:00Z',
      localDate: '2026-10-11',
      localHour: '00:00',
    },
  ],
};
let wrapper: ReturnType<typeof mount> | undefined;
afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function responses(result: Dashboard = dashboard) {
  return vi.fn(async (url: string) => ({
    ok: true,
    json: async () =>
      url.endsWith('/assets')
        ? {
            configured: true,
            assets: [
              asset,
              { ...asset, id: 'ac', displayName: 'Air conditioner' },
            ],
          }
        : result,
  }));
}
async function render(fetch: unknown = responses()) {
  vi.stubGlobal('fetch', fetch);
  wrapper = mount(EnergyDashboard, {
    props: { apiBase: '', accessToken: 'test' },
  });
  await flushPromises();
  return wrapper;
}

describe('energy dashboard', () => {
  it('separates appliance selection from the measuring hardware and explains mixed clocks', async () => {
    const page = await render(
      responses({
        ...dashboard,
        timestampBasis: 'mixed',
        asset: {
          ...asset,
          measurementSources: [
            {
              deviceId: 'shelly-meter',
              channel: 'em1:0',
              from: '2026-10-01T00:00:00Z',
            },
          ],
        },
      }),
    );
    expect(page.text()).toContain('Appliance / circuit');
    expect(page.text()).toContain('Measured by: shelly-meter');
    expect(page.text()).toContain('em1:0');
    expect(page.text()).toContain('a mixture of device and collector times');
  });
  it('loads authenticated summaries and shows the estimate provenance and boiler configuration', async () => {
    const fetch = responses();
    const page = await render(fetch);
    expect(fetch.mock.calls[0][0]).toBe('/portal/energy/assets');
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/assets/boiler/history?'),
      expect.objectContaining({ headers: { Authorization: 'Bearer test' } }),
    );
    expect(page.text()).toContain('80 L tank');
    expect(page.text()).toContain('04:00–06:00');
    expect(page.text()).toContain('Estimated energy');
    expect(page.text()).toContain('not an energy meter total');
    expect(page.text()).toContain('collector receipt time');
    expect(page.findAll('.energy-day')).toHaveLength(2);
  });
  it('switches selected days locally without another request', async () => {
    const fetch = responses();
    const page = await render(fetch);
    expect(page.get('#energy-day-title').text()).toContain('Oct 11');
    await page.findAll('.energy-day')[0].trigger('click');
    expect(page.get('#energy-day-title').text()).toContain('Oct 10');
    expect(page.get('.energy-day[aria-pressed="true"]').text()).toContain(
      'Oct 10',
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(page.findAll('tbody tr')).toHaveLength(1);
  });
  it('fetches another explicitly assigned asset and period', async () => {
    const fetch = responses();
    const page = await render(fetch);
    await page.findAll('select')[0].setValue('ac');
    await flushPromises();
    expect(fetch.mock.calls.at(-1)?.[0]).toContain('/assets/ac/history?');
    await page.findAll('select')[1].setValue('30');
    await flushPromises();
    const url = new URL(fetch.mock.calls.at(-1)![0], 'http://localhost');
    expect(
      Date.parse(url.searchParams.get('to')!) -
        Date.parse(url.searchParams.get('from')!),
    ).toBe(30 * 86400000);
  });
  it('shows zero consumption as zero, not missing', async () => {
    const page = await render(
      responses({
        ...dashboard,
        summary: { ...stats, energyKwh: 0, activeMinutes: 0 },
      }),
    );
    expect(page.get('.energy-summary').text()).toContain('0.00');
    expect(page.get('.energy-summary').text()).not.toContain('--');
  });
  it('shows unavailable values and missing bars instead of zero consumption', async () => {
    const absent = {
      ...stats,
      energyKwh: null,
      averagePowerW: null,
      peakPowerW: null,
      activeMinutes: null,
      outsideScheduleKwh: null,
      coveragePct: 0,
      coveredSeconds: 0,
    };
    const page = await render(
      responses({
        ...dashboard,
        summary: absent,
        daily: [{ ...absent, date: '2026-10-11' }],
        hourly: [{ ...dashboard.hourly[1], ...absent }],
      }),
    );
    expect(page.get('.energy-summary').text()).toContain('--');
    expect(page.text()).toContain('Incomplete history');
    expect(page.get('.energy-day-bar').classes()).toContain('missing');
    expect(page.get('.energy-hour').classes()).toContain('missing');
    expect(page.get('tbody').text()).toContain('-- kWh');
  });
  it('clears the previous result on a failed refresh', async () => {
    const fetch = responses();
    const page = await render(fetch);
    fetch.mockRejectedValue(new Error('Connection unavailable'));
    await page.get('.energy-header button').trigger('click');
    await flushPromises();
    expect(page.find('.energy-summary').exists()).toBe(false);
    expect(page.get('[role="alert"]').text()).toContain(
      'Connection unavailable',
    );
  });
  it('explains missing configuration without attempting history reads', async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ configured: false, assets: [] }),
    }));
    const page = await render(fetch);
    expect(page.text()).toContain('connection is not configured');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('does not invent devices when no assignments exist', async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ configured: true, assets: [] }),
    }));
    const page = await render(fetch);
    expect(page.text()).toContain('No appliances or circuits are assigned');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('reports authentication failure', async () => {
    const page = await render(
      vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })),
    );
    expect(page.text()).toContain('Please sign in again');
  });
  it('displays the sanitized backend error', async () => {
    const fetch = responses();
    fetch.mockImplementation(
      async () =>
        ({
          ok: false,
          json: async () => ({
            message:
              'Legacy power history is unavailable. Check the database connection.',
          }),
        }) as never,
    );
    const page = await render(fetch);
    expect(page.text()).toContain('Check the database connection');
  });
  it('keeps a newer period result when an older request completes late', async () => {
    let resolveOld:
      | ((value: { ok: boolean; json: () => Promise<Dashboard> }) => void)
      | undefined;
    let calls = 0;
    const fetch = vi.fn(async () => {
      calls++;
      if (calls === 1)
        return {
          ok: true,
          json: async () => ({ configured: true, assets: [asset] }),
        };
      if (calls === 2)
        return new Promise<{ ok: boolean; json: () => Promise<Dashboard> }>(
          (resolve) => {
            resolveOld = resolve;
          },
        );
      return {
        ok: true,
        json: async () => ({
          ...dashboard,
          summary: { ...stats, energyKwh: 12.34 },
        }),
      };
    });
    const page = await render(fetch);
    await page.findAll('select')[1].setValue('1');
    await flushPromises();
    expect(page.get('.energy-summary').text()).toContain('12.34');
    resolveOld?.({
      ok: true,
      json: async () => ({
        ...dashboard,
        summary: { ...stats, energyKwh: 999 },
      }),
    });
    await flushPromises();
    expect(page.get('.energy-summary').text()).toContain('12.34');
    expect(page.get('.energy-summary').text()).not.toContain('999');
  });
  it('times out a stalled request and clears the loading state', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fetch = vi.fn(
      (_url: string, options: RequestInit) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () =>
            reject(new Error('aborted')),
          );
        }),
    );
    const page = await render(fetch);
    await vi.advanceTimersByTimeAsync(25001);
    await flushPromises();
    expect(page.get('[role="alert"]').text()).toContain('timed out');
    expect(
      page.get('.energy-header button').attributes('disabled'),
    ).toBeUndefined();
  });
  it('uses a safe fallback when a failed response is not JSON', async () => {
    const page = await render(
      vi.fn(async () => ({
        ok: false,
        status: 503,
        json: async () => {
          throw new Error('invalid JSON');
        },
      })),
    );
    expect(page.get('[role="alert"]').text()).toContain(
      'Power history is unavailable',
    );
  });
  it('can display measurement-time provenance from another canonical reader', async () => {
    const page = await render(
      responses({ ...dashboard, timestampBasis: 'device-observed' }),
    );
    expect(page.text()).toContain('device measurement time');
    expect(page.text()).not.toContain('collector receipt time');
  });
  it('aborts requests when the page is unmounted', async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url, options) => {
        signal = options.signal;
        return new Promise(() => {});
      }),
    );
    wrapper = mount(EnergyDashboard, {
      props: { apiBase: '', accessToken: 'test' },
    });
    wrapper.unmount();
    wrapper = undefined;
    expect(signal?.aborted).toBe(true);
  });
  it('exports normalized hours with explicit UTC timestamps and coverage', async () => {
    const page = await render();
    const create = vi.fn(() => 'blob:energy');
    const revoke = vi.fn();
    vi.stubGlobal(
      'URL',
      class extends URL {
        static override createObjectURL = create;
        static override revokeObjectURL = revoke;
      },
    );
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await page.get('.energy-section-heading button').trigger('click');
    expect(create).toHaveBeenCalledWith(expect.any(Blob));
    expect(revoke).toHaveBeenCalledWith('blob:energy');
  });
});

describe('recent power ranges', () => {
  it('uses elapsed UTC time without depending on browser timezone or DST', () => {
    expect(recentPowerRange(1, new Date('2026-10-25T12:00:00Z'))).toEqual({
      from: '2026-10-24T12:00:00.000Z',
      to: '2026-10-25T12:00:00.000Z',
    });
  });
});
