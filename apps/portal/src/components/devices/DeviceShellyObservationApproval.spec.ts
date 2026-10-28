import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAuthenticatedSession, setAuthenticatedSession } from '../../auth/auth-client';
import DeviceShellyObservationApproval from './DeviceShellyObservationApproval.vue';

const deviceId = 'shellypro2pm-001122334455:switch:0';
const proposal = {
  approved: false,
  approvalStatus: 'missing' as const,
  sourceId: 'shelly-mqtt' as const,
  broker: 'devicebroker.ddns.net:1883',
  selector: '',
  approvedFields: [],
  evidenceFresh: true,
  evidence: { provenance: 'operator_attested_site_local_shelly_rpc_report', observerId: 'pi-housenet', snapshotId: 'site-observer-12345678',
    endpoint: '192.168.1.166', networkScope: 'upstream-lan:192.168.1.0/24', identityVerifiedAt: '2026-10-27T10:00:00.000Z', componentVerifiedAt: '2026-10-27T10:00:00.000Z' },
  fields: [
    { metric: 'power' as const, rawKey: 'power' as const, unit: 'W' as const, displayUnit: 'W' as const },
    { metric: 'energy_import_total' as const, rawKey: 'energy_import_total' as const, unit: 'kWh' as const, displayUnit: 'kWh' as const },
    { metric: 'energy_export_total' as const, rawKey: 'energy_export_total' as const, unit: 'kWh' as const, displayUnit: 'kWh' as const },
  ],
};
let wrapper: ReturnType<typeof mount> | undefined;

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  clearAuthenticatedSession(false);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('DeviceShellyObservationApproval', () => {
  it('requires explicit operator confirmation for the exact component power feed', async () => {
    const topic = 'shelly/washer@other/events/rpc';
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => init?.method === 'POST' ? { ...proposal, selector: topic, approved: true, approvalStatus: 'approved' as const } : proposal,
    }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('confirm', vi.fn(() => false));
    setAuthenticatedSession({ accessToken: 'portal-token', expiresIn: 900, user: { id: 'admin', email: 'admin@test', name: 'Admin', role: 'admin' } });
    wrapper = mount(DeviceShellyObservationApproval, { props: { deviceId, enabled: true, apiBase: '', accessToken: 'portal-token' } });
    await flushPromises();
    expect(wrapper.text()).toContain('Site-local RPC evidence verified this component');
    expect(wrapper.text()).toContain('MQTT identity alone does not authorize them');
    await wrapper.get('button').trigger('click');
    await wrapper.get('input[aria-label="Exact MQTT event topic"]').setValue(topic);
    expect(wrapper.text()).toContain(topic);
    const powerButton = () => wrapper!.findAll('button').find(button => button.text().includes('Approve Power'))!;
    await powerButton().trigger('click');
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.stubGlobal('confirm', vi.fn(() => true));
    await powerButton().trigger('click');
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ confirmedDeviceId: deviceId, confirmedBroker: proposal.broker, approvedFields: ['power'], mqttTopic: topic });
    expect(wrapper.text()).toContain('All reported measurements are explicitly approved');
  });

  it('keeps switch power and cumulative energy as separate operator approvals', async () => {
    const multi = { ...proposal, fields: [
      { metric: 'power' as const, rawKey: 'power', unit: 'W' as const, displayUnit: 'W' as const },
      { metric: 'energy_import_total' as const, rawKey: 'energy_import_total', unit: 'kWh' as const, displayUnit: 'kWh' as const },
      { metric: 'energy_export_total' as const, rawKey: 'energy_export_total', unit: 'kWh' as const, displayUnit: 'kWh' as const },
    ] };
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => ({
      ok: true, status: 200,
      json: async () => init?.method === 'POST'
        ? { ...multi, selector: 'shelly/washer@other/events/rpc', approved: false, approvalStatus: 'partially_approved' as const, approvedFields: ['power'] }
        : multi,
    }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('confirm', vi.fn(() => true));
    setAuthenticatedSession({ accessToken: 'portal-token', expiresIn: 900, user: { id: 'admin', email: 'admin@test', name: 'Admin', role: 'admin' } });
    wrapper = mount(DeviceShellyObservationApproval, { props: { deviceId: 'shellypro2pm-001122334455:switch:1', enabled: true, apiBase: '', accessToken: 'portal-token' } });
    await flushPromises();
    await wrapper.get('button').trigger('click');
    await wrapper.get('input[aria-label="Exact MQTT event topic"]').setValue('shelly/washer@other/events/rpc');
    const powerButton = wrapper.findAll('button').find(button => button.text().includes('Approve Power'))!;
    expect(wrapper.text()).toContain('energy_import_total');
    await powerButton.trigger('click');
    await flushPromises();
    expect(JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body))).toEqual({ confirmedDeviceId: 'shellypro2pm-001122334455:switch:1', confirmedBroker: proposal.broker, approvedFields: ['power'], mqttTopic: 'shelly/washer@other/events/rpc' });
    await wrapper.get('button').trigger('click');
    expect(wrapper.text()).toContain('energy_import_total');
    expect(wrapper.text()).toContain('does not grant device control');
  });

  it('displays historical evidence and its fields but disables new measurement approvals', async () => {
    const historical = { ...proposal, evidenceFresh: false };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => historical })));
    setAuthenticatedSession({ accessToken: 'portal-token', expiresIn: 900, user: { id: 'admin', email: 'admin@test', name: 'Admin', role: 'admin' } });
    wrapper = mount(DeviceShellyObservationApproval, { props: { deviceId, enabled: true, apiBase: '', accessToken: 'portal-token' } });
    await flushPromises();
    await wrapper.get('button').trigger('click');
    expect(wrapper.text()).toContain('This accepted RPC evidence is historical');
    expect(wrapper.text()).toContain('site-observer-12345678');
    expect(wrapper.text()).toContain('energy_import_total');
    expect(wrapper.findAll('button').find(button => button.text().includes('Approve Power'))!.attributes('disabled')).toBeDefined();
  });
});
