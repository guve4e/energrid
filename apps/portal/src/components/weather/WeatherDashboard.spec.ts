import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import WeatherDashboard from './WeatherDashboard.vue';

const forecast = { location: 'Vidin', fetchedAt: new Date().toISOString(), summary: 'Storm risk in one model',
  current: { temperature: 20, gustKmh: 80, windKmh: 30 }, intelligence: { headline: 'Action needed', severity: 'danger', confidence: 'models-disagree' },
  comparison: { status: 'disagreement', selectedModel: 'icon_seamless', sources: [
    { model: 'icon_seamless', fetchedAt: new Date().toISOString(), severity: 'danger', dataQuality: { status: 'available', reasons: [] } },
    { model: 'ncep_gfs_seamless', fetchedAt: new Date().toISOString(), severity: 'unknown', dataQuality: { status: 'stale', reasons: ['stale_or_invalid_timestamp'] } },
  ] }, dataQuality: { status: 'available' } };
let wrapper: ReturnType<typeof mount> | undefined;
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.unstubAllGlobals(); });
function responses(weather: object = { status: 'awaiting-observations', summary: [], pending: { scheduled: 4, awaitingObservations: 2 } }) {
  return vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/dashboard') ? forecast : url.endsWith('/river-performance') ? { summary: [] } : weather }));
}
describe('weather page', () => {
  it('shows source disagreement and awaits observations instead of inventing accuracy', async () => {
    vi.stubGlobal('fetch', responses());
    wrapper = mount(WeatherDashboard, { props: { apiBase: '', accessToken: 'test' } });
    await flushPromises();
    expect(wrapper.text()).toContain('Models: disagreement');
    expect(wrapper.text()).toContain('DWD ICON');
    expect(wrapper.text()).toContain('stale');
    expect(wrapper.text()).toContain('Awaiting measured observations');
    expect(wrapper.text()).toContain('River scores are provisional');
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
});
