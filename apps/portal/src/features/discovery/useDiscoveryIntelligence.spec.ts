import { afterEach, describe, expect, it, vi } from 'vitest';
import { computed, defineComponent, h, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { useDiscoveryIntelligence } from './useDiscoveryIntelligence';
import type { NetworkDevice } from './discovery-contracts';

const device = { id: 'device-1', ipAddress: '172.30.250.3' } as NetworkDevice;
const reply = (body: unknown) => ({ ok: true, json: async () => body }) as Response;
const availability = { mode: 'cloud-enabled', provider: 'openai', available: true, cloudDataConsentRequired: true };
function setup(options: { request?: (url: string, init?: RequestInit) => Promise<Response>; consent?: boolean } = {}) {
  const token = ref('token-a');
  const scope = ref('tenant:site-a');
  const devices = ref<NetworkDevice[]>([device]);
  const request = vi.fn(options.request || (async url => url.endsWith('/availability')
    ? reply(availability) : reply([])));
  const confirm = vi.fn(() => options.consent ?? true);
  let model!: ReturnType<typeof useDiscoveryIntelligence>;
  const wrapper = mount(defineComponent({
    setup() {
      model = useDiscoveryIntelligence({
        apiBase: '/api', accessToken: token, networkDevices: computed(() => devices.value),
        siteScope: () => scope.value,
        request: request as unknown as typeof import('../../auth/auth-client').authFetch,
        confirm,
      });
      return () => h('div');
    },
  }));
  return { model, token, scope, devices, request, confirm, wrapper };
}
afterEach(() => vi.restoreAllMocks());

describe('optional Device Intelligence', () => {
  it('requires operator consent before sending evidence to cloud investigation', async () => {
    const ctx = setup({ consent: false });
    await ctx.model.investigateNetworkDeviceWithAi(device);
    expect(ctx.confirm).toHaveBeenCalledWith(expect.stringContaining('OpenAI'));
    expect(ctx.request.mock.calls.some(([url, init]) =>
      url.endsWith('/investigate') && init?.method === 'POST')).toBe(false);
    expect(ctx.model.aiInvestigating.value['device-1']).toBe(false);
    ctx.wrapper.unmount();
  });

  it('discards an old-site cloud availability response before investigating', async () => {
    let release!: (value: Response) => void;
    const ctx = setup({ request: url => url.endsWith('/availability')
      ? new Promise<Response>(resolve => { release = resolve; })
      : Promise.resolve(reply([])) });
    const pending = ctx.model.investigateNetworkDeviceWithAi(device);
    ctx.scope.value = 'tenant:site-b';
    release(reply(availability));
    await pending;
    expect(ctx.model.selectedAiDeviceId.value).toBeNull();
    expect(ctx.model.aiReports.value).toEqual({});
    expect(ctx.request.mock.calls.some(([url, init]) =>
      url.endsWith('/investigate') && init?.method === 'POST')).toBe(false);
    ctx.wrapper.unmount();
  });

  it('keeps read-only device evidence available when AI provider status fails', async () => {
    const ctx = setup({ request: async url => {
      if (url.endsWith('/availability')) throw new Error('AI service offline');
      return reply([]);
    } });
    ctx.model.openDeviceIntelligenceOnly('device-1');
    await vi.waitFor(() => expect(ctx.model.llmProviderAvailability.value?.reasonCode)
      .toBe('provider-status-unavailable'));
    expect(ctx.model.selectedAiDeviceId.value).toBe('device-1');
    expect(ctx.request.mock.calls.some(([url, init]) =>
      url.endsWith('/investigate') && init?.method === 'POST')).toBe(false);
    ctx.wrapper.unmount();
  });

  it('offers a clearly synthetic MQTT replay preview without requests or installation', () => {
    const ctx = setup();
    ctx.model.previewMqttProfile('device-1');
    const preview = ctx.model.mqttProfileSelected.value['device-1'];
    expect(preview.result.provider).toBe('offline-preview');
    expect(preview.result.replay.installationAuthorized).toBe(false);
    expect(preview.result.proposal.requiresApproval).toBe(true);
    expect(ctx.request).not.toHaveBeenCalled();
    ctx.wrapper.unmount();
  });

  it('clears cached investigations and temporary actions on logout', () => {
    const ctx = setup();
    ctx.model.aiReports.value['device-1'] = { deviceId: 'device-1', provider: 'local', model: 'x', report: { summary: 'old', findings: [], unknowns: [], nextSteps: [] } };
    ctx.model.selectedAiDeviceId.value = 'device-1';
    ctx.token.value = '';
    expect(ctx.model.aiReports.value).toEqual({});
    expect(ctx.model.selectedAiDeviceId.value).toBeNull();
    expect(ctx.model.llmProviderAvailability.value).toBeNull();
    ctx.wrapper.unmount();
  });
});
