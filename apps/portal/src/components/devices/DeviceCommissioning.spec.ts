import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import DeviceCommissioning from './DeviceCommissioning.vue';

const baseDevice = {
  id: 'shellyplus1-aabbcc:switch:0',
  displayName: 'Relay',
  zoneName: 'Kitchen',
  trustStatus: 'approved',
  commissioning: { physicalOutcome: 'not_confirmed' as const, confirmedAt: null },
  state: { command: { status: 'pending' } },
};

afterEach(() => vi.unstubAllGlobals());

describe('DeviceCommissioning', () => {
  it('saves the installer-assigned name and room through the authenticated API', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetch);
    const page = mount(DeviceCommissioning, {
      props: { device: baseDevice, apiBase: '', accessToken: 'unit-token' },
    });
    await page.get('input').setValue('Hall light');
    await page.findAll('input')[1].setValue('Hall');
    await page.get('form').trigger('submit');
    await flushPromises();

    expect(fetch).toHaveBeenCalledWith(
      `/portal/devices/${encodeURIComponent(baseDevice.id)}/commissioning`,
      expect.objectContaining({
        method: 'PATCH',
        headers: expect.objectContaining({ Authorization: 'Bearer unit-token' }),
        body: JSON.stringify({
          displayName: 'Hall light',
          zoneName: 'Hall',
          settingsUrl: null,
          assistantEnabled: false,
        }),
      }),
    );
    expect(page.emitted('saved')).toHaveLength(1);
  });

  it('requires an acknowledged device report before allowing physical confirmation', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetch);
    const page = mount(DeviceCommissioning, {
      props: { device: baseDevice, apiBase: '', accessToken: 'unit-token' },
    });
    expect(page.text()).toContain('Physical result: not confirmed');
    expect(page.find('button.secondary').exists()).toBe(false);
    await page.setProps({ device: { ...baseDevice, state: { command: { status: 'acked' } } } });
    await page.get('button.secondary').trigger('click');
    await flushPromises();

    expect(fetch).toHaveBeenCalledWith(
      `/portal/devices/${encodeURIComponent(baseDevice.id)}/commissioning/confirm-physical-outcome`,
      expect.objectContaining({ method: 'POST' }),
    );
    expect(page.emitted('saved')).toHaveLength(1);
  });

  it('shows API failures without claiming the installation was saved', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ message: 'Storage unavailable' }),
    }));
    const page = mount(DeviceCommissioning, {
      props: { device: baseDevice, apiBase: '', accessToken: 'unit-token' },
    });
    await page.get('form').trigger('submit');
    await flushPromises();
    expect(page.get('[role="alert"]').text()).toBe('Storage unavailable');
    expect(page.emitted('saved')).toBeUndefined();
  });

  it('saves settings access and explicit assistant permission with the device name and room', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetch);
    const page = mount(DeviceCommissioning, {
      props: {
        device: baseDevice,
        apiBase: '',
        accessToken: 'unit-token',
        settingsUrlSuggestion: 'http://192.168.1.21',
      },
    });
    expect((page.find('input[type="url"]').element as HTMLInputElement).value)
      .toBe('http://192.168.1.21');
    await page.find('input[type="checkbox"]').setValue(true);
    await page.get('form').trigger('submit');
    await flushPromises();
    expect(fetch).toHaveBeenCalledWith(
      `/portal/devices/${encodeURIComponent(baseDevice.id)}/commissioning`,
      expect.objectContaining({
        body: JSON.stringify({
          displayName: 'Relay',
          zoneName: 'Kitchen',
          settingsUrl: 'http://192.168.1.21',
          assistantEnabled: true,
        }),
      }),
    );
  });

  it('rejects non-HTTP settings addresses before sending them to the API', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const page = mount(DeviceCommissioning, {
      props: {
        device: baseDevice,
        apiBase: '',
        accessToken: 'unit-token',
        settingsUrlSuggestion: 'http://192.168.1.20',
      },
    });
    await page.find('input[type="url"]').setValue('javascript:alert(1)');
    await page.get('form').trigger('submit');
    await flushPromises();
    expect(fetch).not.toHaveBeenCalledWith(
      `/portal/devices/${encodeURIComponent(baseDevice.id)}/commissioning`,
      expect.anything(),
    );
    expect(page.get('[role="alert"]').text()).toContain('HTTP or HTTPS');
  });

  it('renders a concise, human-readable command record from installation history', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ events: [{
        id: 'event-1',
        kind: 'command',
        occurredAt: '2026-10-16T10:00:00.000Z',
        evidence: { stage: 'result', action: 'turn_on', status: 'acked', adapter: 'shelly-http' },
      }] }),
    }));
    const page = mount(DeviceCommissioning, {
      props: { device: baseDevice, apiBase: '', accessToken: 'unit-token' },
    });
    await flushPromises();
    expect(page.text()).toContain('Command acked');
    expect(page.text()).toContain('turn_on · shelly-http');
  });
});
