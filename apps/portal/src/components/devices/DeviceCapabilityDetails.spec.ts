import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import DeviceCapabilityDetails from './DeviceCapabilityDetails.vue';
import { setAuthenticatedSession, clearAuthenticatedSession } from '../../auth/auth-client';

const climate: Array<{ kind: string; actions: string[]; unit?: string }> = [{ kind: 'temperature', actions: ['read'], unit: 'Cel' }, { kind: 'humidity', actions: ['read'], unit: '%RH' }];
const switchCapability: { kind: string; actions: string[]; unit?: string } = { kind: 'switch', actions: ['turn_on', 'turn_off'] };
const powerCapability: { kind: string; actions: string[]; unit?: string } = { kind: 'power', actions: ['read'], unit: 'W' };
const currentTime = new Date().toISOString();
const baseDevice: any = {
  id: 'device-1', trustStatus: 'approved', displayName: 'Device', capabilities: [], supportedCapabilities: [],
  adapter: { protocol: 'mqtt', driver: 'generic-mqtt', target: 'site/device' },
  control: { status: 'read-only' as const, binding: null, reason: 'No control route.' },
  state: { values: {}, observedAt: currentTime, status: 'online' },
};
let wrapper: ReturnType<typeof mount> | undefined;
let readModelHistoryMetrics: string[] = ['power'];

const approvedClimateBinding = {
  approved: true,
  approvalStatus: 'approved',
  sourceId: 'energrid-http-status',
  selector: '/api/v1/status',
  fields: [
    { metric: 'temperature', rawKey: 'temperatureC', unit: 'Cel', displayUnit: '°C' },
    { metric: 'humidity', rawKey: 'humidityPct', unit: '%RH', displayUnit: '%RH' },
  ],
};
function installFetch(
  fields: Record<string, unknown> = {},
  authority = { ...approvedClimateBinding, approved: false, approvalStatus: 'missing' },
  authorizedHistoryMetrics: string[] = ['power'],
  httpPowerApproved = false,
) {
  readModelHistoryMetrics = authorizedHistoryMetrics;
  const fetchMock = vi.fn(async (url: string) => {
    if (url.includes('/read-model')) {
      const deviceId = decodeURIComponent(new URL(url, window.location.origin).pathname.split('/').slice(-2)[0]);
      return { ok: true, json: async () => ({ identity: { id: deviceId, kind: 'physical' }, installation: { status: 'enrolled' }, history: { authorizedMetrics: readModelHistoryMetrics } }) };
    }
    if (url.includes('/shelly-observation-approval')) return { ok: true, json: async () => ({
      approved: true, approvalStatus: 'approved', sourceId: 'shelly-mqtt', broker: '127.0.0.1:1883', selector: 'shelly/meter/events/rpc', approvedFields: ['power'], evidenceFresh: true,
      evidence: { provenance: 'rpc', observerId: 'observer', snapshotId: 'snapshot', endpoint: '192.168.7.39', networkScope: 'eero-lan', identityVerifiedAt: currentTime, componentVerifiedAt: currentTime },
      fields: [{ metric: 'power', rawKey: 'apower', unit: 'W', displayUnit: 'W' }],
    }) };
    if (url.includes('/shelly-http-em1-approval')) return { ok: true, json: async () => ({
      approved: httpPowerApproved, approvalStatus: httpPowerApproved ? 'approved' : 'missing', sourceId: 'shelly-http-em1', selector: 'EM1.GetStatus?id=0',
      endpoint: '192.168.7.54', networkScope: 'gateway-unknown:eero-lan',
      fields: [{ metric: 'power', rawKey: 'power', unit: 'W' }],
    }) };
    if (url.includes('/observations')) {
      const deviceId = decodeURIComponent(new URL(url, window.location.origin).pathname.split('/').slice(-2)[0]);
      return { ok: true, json: async () => ({ deviceId, freshnessLimitSeconds: 60, fields }) };
    }
    if (url.includes('/observation-approval')) return { ok: true, json: async () => authority };
    if (url.includes('/electrical-measurements')) {
      const metric = new URL(url, window.location.origin).searchParams.get('metric') || 'power';
      return { ok: true, json: async () => ({ deviceId: 'device-1', metric, unit: metric === 'power' ? 'W' : 'kWh', measurements: [{ observedAt: currentTime, value: metric === 'power' ? 96 : 1.4, unit: metric === 'power' ? 'W' : 'kWh' }] }) };
    }
    const parsedUrl = new URL(url, window.location.origin);
    const metric = parsedUrl.searchParams.get('metric') || 'temperature';
    const deviceId = decodeURIComponent(parsedUrl.pathname.split('/').slice(-2)[0]);
    return { ok: true, json: async () => ({ deviceId, metric, unit: metric === 'temperature' ? 'Cel' : '%RH', measurements: [{ observedAt: currentTime, value: 20, quality: 'measured' }] }) };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
async function render(device: any) {
  setAuthenticatedSession({ accessToken: 'token', expiresIn: 900, user: { id: 'admin', email: 'admin@example.test', name: 'Admin', role: 'admin' } });
  wrapper = mount(DeviceCapabilityDetails, { props: { device, apiBase: '', accessToken: 'token', approvalRevision: 0, controlReady: device.control.status === 'ready' } });
  await flushPromises();
  return wrapper;
}
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.unstubAllGlobals(); clearAuthenticatedSession(false); });

describe('capability-driven Device Details', () => {
  it('renders DHT22 climate readings and history', async () => {
    installFetch({ temperature: { value: 20.1, sourceId: 'approved', receivedAt: currentTime, ageSeconds: 1, freshness: 'fresh', authority: 'approved' }, humidity: { value: 45, sourceId: 'approved', receivedAt: currentTime, ageSeconds: 1, freshness: 'fresh', authority: 'approved' } });
    const page = await render({ ...baseDevice, adapter: { protocol: 'http', driver: 'energrid-esp8266' }, capabilities: climate, supportedCapabilities: climate });
    expect(page.text()).toContain('Temperature');
    expect(page.text()).toContain('Humidity');
    expect(page.text()).toContain('Measurement history');
    expect(page.findAll('.electrical-chart-card')).toHaveLength(0);
    expect(page.findAll('.device-switch-control')).toHaveLength(0);
  });
  it.each([
    { id: 'device:upstream-lan:esp8266:324864', temperature: 9.4, humidity: 73.2, freshness: 'fresh', status: 'online' },
    { id: 'device:eero-lan:esp8266:324b44', temperature: 8.9, humidity: 76.1, freshness: 'stale', status: 'offline' },
    { id: 'device:upstream-lan:esp8266:3254b7', temperature: 7.3, humidity: 99.9, freshness: 'fresh', status: 'online' },
  ])('renders authorized current readings and graphs for $id from saved field bindings', async ({ id, temperature, humidity, freshness, status }) => {
    const ageSeconds = freshness === 'fresh' ? 1 : 8_000;
    const receivedAt = new Date(Date.now() - ageSeconds * 1000).toISOString();
    installFetch({
      temperature: { value: temperature, sourceId: 'energrid-http-status', receivedAt, ageSeconds, freshness, authority: 'approved' },
      humidity: { value: humidity, sourceId: 'energrid-http-status', receivedAt, ageSeconds, freshness, authority: 'approved' },
    }, approvedClimateBinding);
    const page = await render({
      ...baseDevice,
      id,
      adapter: { protocol: 'http', driver: 'energrid-esp8266', target: 'http://device.local/api/v1/status' },
      metadata: { observationApprovalRequired: true },
      capabilities: [],
      supportedCapabilities: [],
      state: { values: { temperature, humidity }, observedAt: receivedAt, status },
    });
    expect(page.text()).toContain('Temperature');
    expect(page.text()).toContain('Humidity');
    if (freshness === 'fresh') {
      expect(page.text()).toContain(`${temperature}`);
      expect(page.text()).toContain(`${humidity}`);
    } else {
      expect(page.text()).toContain('Disconnected');
      expect(page.text()).toContain('Stale');
    }
    expect(page.findAll('.measurement-chart')).toHaveLength(2);
  });
  it('renders a relay-only switch state and no measurement cards or history requests', async () => {
    const fetchMock = installFetch();
    const shellyId = 'shellyplus1-78ee4ccf4b54:switch:0';
    const page = await render({ ...baseDevice, id: shellyId, displayName: 'shellyplus1-78ee4ccf4b54 switch:0', adapter: { protocol: 'mqtt', driver: 'shelly-discovered', target: 'shellyplus1-78ee4ccf4b54' }, capabilities: [switchCapability], supportedCapabilities: [switchCapability], control: { status: 'ready', binding: { kind: 'generic-mqtt', enabled: true, topic: 'site/device/command' }, reason: '' }, state: { values: { on: false, power: 0 }, observedAt: currentTime, status: 'online' } });
    expect(page.text()).toContain('Relay is Off');
    expect(page.findAll('.current-measurement')).toHaveLength(0);
    expect(page.findAll('.measurement-chart')).toHaveLength(0);
    expect(page.findAll('.electrical-chart-card')).toHaveLength(0);
    expect(page.find('.device-switch-control').exists()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('shows both relay control and authorized power and energy series for a power-monitoring switch', async () => {
    installFetch({}, undefined, ['power', 'energy_import_total', 'energy_export_total']);
    const page = await render({ ...baseDevice, capabilities: [switchCapability, powerCapability], supportedCapabilities: [switchCapability, powerCapability], control: { status: 'ready', binding: { kind: 'generic-mqtt', enabled: true, topic: 'site/device/command' }, reason: '' }, state: { values: { on: false }, observedAt: currentTime, status: 'online' } });
    expect(page.text()).toContain('Relay is Off');
    expect(page.text()).toContain('Electrical measurements');
    expect(page.text()).toContain('Imported energy');
    expect(page.text()).toContain('96 W');
    expect(page.find('.device-switch-control').exists()).toBe(true);
    expect(page.findAll('.current-measurement')).toHaveLength(0);
  });
  it('shows no measurements or controls for an unknown capability set', async () => {
    const fetchMock = installFetch();
    const page = await render(baseDevice);
    expect(page.findAll('.device-observation-overview')).toHaveLength(0);
    expect(page.find('.device-switch-control').exists()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('shows an approval step when climate support is verified but observation permission is absent', async () => {
    installFetch({});
    const page = await render({ ...baseDevice, adapter: { protocol: 'http', driver: 'energrid-esp8266' }, metadata: { observationApprovalRequired: true }, supportedCapabilities: climate, capabilities: [] });
    expect(page.text()).toContain('Measurement approval required');
    expect(page.text()).toContain('No authorized temperature or humidity observations are available');
    expect(page.findAll('.measurement-chart')).toHaveLength(0);
  });
  it('renders the EM1 approval review for the exact approved HTTP Shelly component', async () => {
    const fetchMock = installFetch({}, undefined, []);
    const id = 'shellyproem50-8c4f00dbd258:em1:0';
    const page = await render({
      ...baseDevice, id, displayName: 'Energy meter 1', kind: 'physical', trustStatus: 'approved',
      adapter: { protocol: 'http', driver: 'shelly-lan', target: 'http://192.168.7.54/rpc/EM1.GetStatus?id=0', configured: true },
      metadata: { component: 'em1:0', physicalId: 'shellyproem50-8c4f00dbd258', channel: 0 },
      capabilities: [], supportedCapabilities: [powerCapability],
    });
    expect(page.text()).toContain('HTTP power observation approval required');
    expect(page.text()).toContain('Review HTTP power source');
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining(`/portal/devices/${encodeURIComponent(id)}/shelly-http-em1-approval`), expect.anything());
  });
  it('loads HTTP EM50 power history from the source-independent authorized history projection', async () => {
    const fetchMock = installFetch({}, undefined, ['power'], true);
    const id = 'shellyproem50-8c4f00dbd258:em1:0';
    const page = await render({
      ...baseDevice, id, displayName: 'Energy meter', kind: 'physical', trustStatus: 'approved',
      adapter: { protocol: 'http', driver: 'shelly-lan', target: 'http://192.168.7.54/rpc/EM1.GetStatus?id=0', configured: true },
      metadata: { component: 'em1:0', physicalId: 'shellyproem50-8c4f00dbd258' },
      capabilities: [], supportedCapabilities: [powerCapability],
    });
    expect(page.text()).toContain('Power is authorized from');
    expect(page.text()).toContain('Electrical measurements');
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/electrical-measurements?'))).toHaveLength(1);
    expect(page.find('.device-switch-control').exists()).toBe(false);
  });
  it('loads MQTT Pro 2PM power history through the same authorization projection without implying relay control', async () => {
    const fetchMock = installFetch({}, undefined, ['power']);
    const id = 'shellypro2pm-ec6260888084:switch:0';
    const page = await render({
      ...baseDevice, id, kind: 'physical', trustStatus: 'approved',
      adapter: { protocol: 'mqtt', driver: 'shelly-discovered', target: 'shellypro2pm-ec6260888084' },
      metadata: { component: 'switch:0', physicalId: 'shellypro2pm-ec6260888084',
        identityEvidenceSource: 'verified_site_local_shelly_rpc', componentEvidenceSource: 'verified_site_local_shelly_rpc', shellyMqttObservationApprovalRequired: true },
      capabilities: [switchCapability], supportedCapabilities: [switchCapability, powerCapability],
      control: { status: 'read-only', binding: null, reason: 'No switching authorization.' },
      state: { values: { on: false }, observedAt: currentTime, status: 'online' },
    });
    expect(page.text()).toContain('Electrical measurements');
    expect(page.find('.device-switch-control').exists()).toBe(false);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/electrical-measurements?'))).toHaveLength(1);
  });
  it('does not request electrical history when power is supported but source authorization is absent', async () => {
    const fetchMock = installFetch({}, undefined, []);
    const page = await render({ ...baseDevice, capabilities: [], supportedCapabilities: [powerCapability] });
    expect(page.text()).not.toContain('Electrical measurements');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/electrical-measurements?'))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/read-model'))).toBe(true);
  });
  it('updates history eligibility when the approved source projection changes', async () => {
    const fetchMock = installFetch({}, undefined, []);
    const page = await render({ ...baseDevice, capabilities: [], supportedCapabilities: [powerCapability] });
    expect(page.text()).not.toContain('Electrical measurements');
    // Simulate a persisted source approval followed by the existing Portal approval revision.
    readModelHistoryMetrics = ['power'];
    await page.setProps({ approvalRevision: 1 });
    await flushPromises();
    expect(page.text()).toContain('Electrical measurements');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/electrical-measurements?metric=power'))).toBe(true);
  });
  it('keeps source-bound sensor measurements visible while awaiting observation approval', async () => {
    const missingApproval = { ...approvedClimateBinding, approved: false, approvalStatus: 'missing' };
    const fetchMock = installFetch({}, missingApproval);
    const page = await render({
      ...baseDevice,
      adapter: { protocol: 'http', driver: 'energrid-esp8266', target: 'http://device.local/api/v1/status' },
      metadata: { observationApprovalRequired: true },
      capabilities: [],
      supportedCapabilities: [],
    });
    expect(page.text()).toContain('Measurement approval required');
    await page.findAll('button').find(button => button.text() === 'Review measurement proposal')!.trigger('click');
    expect(page.text()).toContain('temperatureC → temperature (°C)');
    expect(page.text()).toContain('humidityPct → humidity (%RH)');
    expect(page.text()).toContain('No authorized temperature or humidity observations are available');
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('/observation-approval'), expect.objectContaining({ method: 'POST' }));
  });
  it('restores readings authorized by a read capability when the support list is incomplete', async () => {
    installFetch({ temperature: { value: 21.4, sourceId: 'approved', receivedAt: currentTime, ageSeconds: 1, freshness: 'fresh', authority: 'approved' } });
    const page = await render({
      ...baseDevice,
      supportedCapabilities: [switchCapability],
      capabilities: [{ kind: 'temperature', actions: ['read'] }],
    });
    expect(page.text()).toContain('Temperature');
    expect(page.text()).toContain('21.4');
    expect(page.text()).not.toContain('Humidity');
  });
  it('marks stale relay state and does not expose an unverified switch control', async () => {
    const old = new Date(Date.now() - 60 * 60_000).toISOString();
    const page = await render({ ...baseDevice, capabilities: [switchCapability], supportedCapabilities: [switchCapability], state: { values: { on: true }, observedAt: old, status: 'online' } });
    expect(page.text()).toContain('Last reported On · stale');
    expect(page.text()).toContain('Stale');
    expect(page.find('.device-switch-control').exists()).toBe(false);
  });
  it('combines climate and electrical sections when both are supported', async () => {
    installFetch({ temperature: { value: 20, sourceId: 'approved', receivedAt: currentTime, ageSeconds: 1, freshness: 'fresh', authority: 'approved' } });
    const page = await render({ ...baseDevice, capabilities: [...climate, powerCapability], supportedCapabilities: [...climate, powerCapability] });
    expect(page.text()).toContain('Temperature');
    expect(page.text()).toContain('Electrical measurements');
    expect(page.findAll('.measurement-chart').length).toBeGreaterThan(0);
    expect(page.findAll('.electrical-chart-card').length).toBeGreaterThan(0);
  });
});
