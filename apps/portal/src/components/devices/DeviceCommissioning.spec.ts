import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import DeviceCommissioning from './DeviceCommissioning.vue';
import { setAuthenticatedSession } from '../../auth/auth-client';

const baseDevice = {
  id: 'shellyplus1-aabbcc:switch:0',
  displayName: 'Relay',
  zoneName: 'Kitchen',
  trustStatus: 'approved',
  commissioning: { physicalOutcome: 'not_confirmed' as const, confirmedAt: null },
  state: { command: { status: 'pending' } },
};

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => setAuthenticatedSession({ accessToken: 'unit-token', expiresIn: 900, user: { id: 'u1', email: 'admin@example.test', name: 'Admin', role: 'admin' } }));

describe('DeviceCommissioning', () => {
  it('saves the installer-assigned name and room through the authenticated API', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetch);
    const page = mount(DeviceCommissioning, {
      props: { device: baseDevice, apiBase: '', accessToken: 'unit-token' },
    });
    expect(page.get('button[type="submit"]').attributes('disabled')).toBeDefined();
    await page.get('input').setValue('Hall light');
    await page.findAll('input')[1].setValue('Hall');
    expect(page.text()).toContain('Unsaved changes');
    expect(page.text()).toContain('Saved: Relay · Kitchen');
    await page.get('form').trigger('submit');
    await flushPromises();

    const patchCall = fetch.mock.calls.find(([url, options]) => url === `/portal/devices/${encodeURIComponent(baseDevice.id)}/commissioning` && options?.method === 'PATCH');
    expect(patchCall).toBeDefined();
    expect(patchCall?.[1]).toMatchObject({
        method: 'PATCH',
        body: JSON.stringify({
          displayName: 'Hall light',
          zoneName: 'Hall',
          settingsUrl: null,
          assistantEnabled: false,
        }),
      });
    expect(new Headers(patchCall?.[1]?.headers).get('Authorization')).toBe('Bearer unit-token');
    expect(page.emitted('saved')).toHaveLength(1);
    expect(page.text()).toContain('Installation changes saved.');
  });

  it('warns before reverting pending edits and restores the saved values', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetch);
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    const page = mount(DeviceCommissioning, {
      props: { device: baseDevice, apiBase: '', accessToken: 'unit-token' },
    });
    await page.get('input').setValue('New name');
    await page.get('button.secondary').trigger('click');
    expect(confirm).toHaveBeenCalledWith('Discard unsaved installation changes?');
    expect((page.get('input').element as HTMLInputElement).value).toBe('New name');
    confirm.mockReturnValue(true);
    await page.get('button.secondary').trigger('click');
    expect((page.get('input').element as HTMLInputElement).value).toBe('Relay');
    expect(page.text()).toContain('Saved configuration');
    expect(fetch.mock.calls.some(([, options]) => options?.method === 'PATCH')).toBe(false);
  });

  it('requires an acknowledged device report before allowing physical confirmation', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetch);
    const page = mount(DeviceCommissioning, {
      props: { device: baseDevice, apiBase: '', accessToken: 'unit-token' },
    });
    expect(page.text()).toContain('Physical command result: not confirmed');
    expect(page.text()).not.toContain('Confirm physical result');
    const acknowledgedProps = {
      device: { ...baseDevice, state: { command: { status: 'acked' } } },
    };
    await page.setProps(
      acknowledgedProps as Parameters<typeof page.setProps>[0],
    );
    const confirmationButton = page.findAll('button').find(button => button.text() === 'Confirm physical result');
    expect(confirmationButton).toBeDefined();
    await confirmationButton!.trigger('click');
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
    await page.get('input').setValue('New name');
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
    expect((page.find('input[type="url"]').element as HTMLInputElement).value).toBe('');
    expect(page.find('input[type="url"]').attributes('placeholder')).toBe('http://192.168.1.21');
    await page.find('input[type="url"]').setValue('http://192.168.1.21');
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
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ events: [] }) });
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
