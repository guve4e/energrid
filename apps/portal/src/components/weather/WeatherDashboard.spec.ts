import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import WeatherDashboard from './WeatherDashboard.vue';

const forecast = { location: 'Vidin', fetchedAt: new Date().toISOString(), summary: 'Storm risk in one model',
  current: { temperature: 20, gustKmh: 80, windKmh: 30 }, intelligence: { headline: 'Action needed', severity: 'danger', confidence: 'models-disagree' },
  daily: Array.from({ length: 12 }, (_, index) => ({
    date: `2026-10-${String(index + 6).padStart(2, '0')}`,
    tempMax: 20 + index,
    tempMin: 10 + index,
    rainTotalMm: index,
    rainChanceMax: index * 5,
    weatherCode: index % 2 ? 61 : 1,
    condition: index % 2 ? 'Slight rain' : 'Mainly clear',
    gustMaxKmh: 20 + index,
    sourceModel: index === 1 ? 'ncep_gfs_seamless' : 'icon_seamless',
    agreement: index === 1 ? 'disagreement' : 'agreement',
  })),
  comparison: { status: 'disagreement', selectedModel: 'icon_seamless', sources: [
    { model: 'icon_seamless', fetchedAt: new Date().toISOString(), severity: 'danger', dataQuality: { status: 'available', reasons: [] } },
    { model: 'ncep_gfs_seamless', fetchedAt: new Date().toISOString(), severity: 'unknown', dataQuality: { status: 'stale', reasons: ['stale_or_invalid_timestamp'] } },
  ], selectionReason: 'Selected because it reports the highest weather risk among usable models.' }, dataQuality: { status: 'available' } };
let wrapper: ReturnType<typeof mount> | undefined;
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.unstubAllGlobals(); vi.useRealTimers(); });
function responses(weather: object = { status: 'awaiting-observations', summary: [], pending: { scheduled: 4, awaitingObservations: 2 } }, dashboard: object = forecast) {
  return vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/dashboard') ? dashboard : url.endsWith('/river-performance') ? { summary: [] } : weather }));
}
function responsesWithRiver(river: object) {
  return vi.fn(async (url: string) => ({
    ok: true,
    json: async () => url.endsWith('/dashboard') ? forecast :
      url.endsWith('/river-performance') ? river :
        { status: 'awaiting-observations', summary: [], pending: { scheduled: 4, awaitingObservations: 2 } },
  }));
}
describe('weather page', () => {
  it('shows source disagreement and awaits observations instead of inventing accuracy', async () => {
    vi.stubGlobal('fetch', responses());
    wrapper = mount(WeatherDashboard, { props: { apiBase: '', accessToken: 'test' } });
    await flushPromises();
    expect(wrapper.text()).toContain('Models: disagreement');
    expect(wrapper.text()).toContain('DWD ICON');
    expect(wrapper.text()).toContain('Selected because it reports the highest weather risk among usable models.');
    expect(wrapper.text()).toContain('stale');
    expect(wrapper.text()).toContain('Awaiting measured observations');
    expect(wrapper.text()).toContain('River scores are provisional');
  });
  it('shows the selected model 10-day forecast with rain and gust details', async () => {
    vi.stubGlobal('fetch', responses());
    wrapper = mount(WeatherDashboard, { props: { apiBase: '', accessToken: 'test' } });
    await flushPromises();
    expect(wrapper.text()).toContain('10-day forecast');
    expect(wrapper.text()).toContain('1 cautious day');
    expect(wrapper.text()).toContain('Cautious');
    expect(wrapper.text()).toContain('NOAA GFS');
    expect(wrapper.text()).toContain('Mainly clear');
    expect(wrapper.text()).toContain('Slight rain');
    expect(wrapper.text()).toContain('9.0 mm = 9.0 L/m²');
    expect(wrapper.text()).toContain('meaningful · 45% rain');
    expect(wrapper.findAll('.day-card')).toHaveLength(10);
  });
  it('removes old current weather after a failed refresh while keeping independent accuracy results', async () => {
    const fetch = responses(); vi.stubGlobal('fetch', fetch);
    wrapper = mount(WeatherDashboard, { props: { apiBase: '', accessToken: 'test' } });
    await flushPromises(); expect(wrapper.text()).toContain('Storm risk in one model');
    fetch.mockRejectedValue(new Error('offline'));
    await wrapper.get('button').trigger('click'); await flushPromises();
    expect(wrapper.text()).not.toContain('Storm risk in one model');
    expect(wrapper.text()).toContain('Current forecast: offline');
  });
  it('defaults to today and switches the selected day without changing current conditions or fetching again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-06T09:00:00Z'));
    const fetch = responses(); vi.stubGlobal('fetch', fetch);
    wrapper = mount(WeatherDashboard, { props: { apiBase: '', accessToken: 'test' } });
    await flushPromises();
    expect(wrapper.get('.day-card[aria-pressed="true"]').text()).toContain('Oct 6');
    await wrapper.findAll('.day-card')[1].trigger('click');
    expect(wrapper.get('#selected-day-title').text()).toContain('October 7');
    expect(wrapper.get('#selected-day-panel').text()).toContain('Cautious · models differ');
    expect(wrapper.get('#selected-day-panel').text()).toContain('NOAA GFS');
    expect(wrapper.get('.weather-metrics').text()).toContain('20.0 °C');
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(wrapper.get('#selected-day-panel').text()).toContain('Hourly details unavailable');
  });
  it('preserves a selected day on refresh and falls back when that day leaves the horizon', async () => {
    const fetch = responses(); vi.stubGlobal('fetch', fetch);
    wrapper = mount(WeatherDashboard, { props: { apiBase: '', accessToken: 'test' } });
    await flushPromises();
    await wrapper.findAll('.day-card')[1].trigger('click');
    await wrapper.get('button').trigger('click'); await flushPromises();
    expect(wrapper.get('#selected-day-title').text()).toContain('October 7');
    fetch.mockImplementation(responses(undefined, { ...forecast, daily: forecast.daily.slice(5) }));
    await wrapper.get('button').trigger('click'); await flushPromises();
    expect(wrapper.get('#selected-day-title').text()).not.toContain('October 7');
    expect(wrapper.findAll('.day-card[aria-pressed="true"]')).toHaveLength(1);
  });
  it('shows the backend weather outage reason instead of hiding it behind a retry message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({ message: 'Weather service unavailable. Check that the core service is running.' }),
    })));
    wrapper = mount(WeatherDashboard, { props: { apiBase: '', accessToken: 'test' } });
    await flushPromises();
    expect(wrapper.text()).toContain('Current forecast: Weather service unavailable. Check that the core service is running.');
    expect(wrapper.text()).not.toContain('Temporarily unavailable. Please retry.');
  });
  it('renders zero scores as valid and flags a small sample', async () => {
    vi.stubGlobal('fetch', responses({ status: 'available', summary: [{ modelVersion: 'icon_seamless:weather-v1',metric: 'rain_probability',horizonHours: 6,
      observationSource: 'station',samples: 3,mae: 0,rmse: 0,bias: 0,brierScore: 0,skillVsPersistence: null }] }));
    wrapper = mount(WeatherDashboard, { props: { apiBase: '', accessToken: 'test' } }); await flushPromises();
    expect(wrapper.text()).toContain('0.000'); expect(wrapper.text()).toContain('Limited evidence');
  });
  it('explains missing storage', async () => {
    vi.stubGlobal('fetch', responses({ status: 'migration-required', summary: [] }));
    wrapper = mount(WeatherDashboard, { props: { apiBase: '', accessToken: 'test' } }); await flushPromises();
    expect(wrapper.text()).toContain('Forecast storage needs initialization');
  });
  it('passes daily verification and collection health through the existing independent performance request', async () => {
    vi.stubGlobal('fetch', responses({status:'awaiting-observations',summary:[],
      daily:{status:'awaiting-observations',summary:[],recent:[]},
      collection:{status:'configuration-required',source:null,note:'Connect a measured station.'}}));
    wrapper = mount(WeatherDashboard,{props:{apiBase:'',accessToken:'test'}}); await flushPromises();
    expect(wrapper.text()).toContain('Forecast versus measured weather');
    expect(wrapper.text()).toContain('Measurement source not connected');
    expect(wrapper.text()).toContain('Hourly forecast accuracy');
  });
  it('explains missing river scoring storage separately', async () => {
    vi.stubGlobal('fetch', responsesWithRiver({ status: 'migration-required', summary: [] }));
    wrapper = mount(WeatherDashboard, { props: { apiBase: '', accessToken: 'test' } }); await flushPromises();
    expect(wrapper.text()).toContain('River forecast storage needs initialization');
  });
});
