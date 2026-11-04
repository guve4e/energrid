import { ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authFetch } from '../auth/auth-client';
import { usePortalState } from './usePortalState';

vi.mock('../auth/auth-client', () => ({ authFetch: vi.fn() }));
const fetchMock = vi.mocked(authFetch);
function setup(page = 'devices') {
  const loadMembership = vi.fn(async () => {});
  const loadDiscoveryMemory = vi.fn(async () => {});
  const beforeSiteSwitch = vi.fn();
  const onSiteSwitchFailure = vi.fn();
  const accessToken = ref('lab-token');
  const model = usePortalState({ apiBase: '', accessToken,
    activePage: ref(page), serverLabel: ref('local'), onLog: vi.fn(),
    loadMembership, loadDiscoveryMemory, beforeSiteSwitch, onSiteSwitchFailure });
  return { model, accessToken, loadMembership, loadDiscoveryMemory, beforeSiteSwitch, onSiteSwitchFailure };
}
const validState = { tenant: { id: 't', name: 'Tenant' }, site: { id: 'lab', name: 'Lab' },
  zones: [], devices: [], voice: { websocketPath: '/voice', provider: 'test' } };

describe('usePortalState', () => {
  beforeEach(() => fetchMock.mockReset());
  it('loads authenticated site state and membership without inventing reachability', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => validState } as Response);
    const { model, loadMembership, loadDiscoveryMemory } = setup();
    await model.loadState();
    expect(model.state.value?.site.id).toBe('lab');
    expect(loadMembership).toHaveBeenCalledTimes(1);
    expect(loadDiscoveryMemory).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/portal/state');
  });
  it('only loads Discovery memory when the Discovery route is selected', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => validState } as Response);
    const { model, loadDiscoveryMemory } = setup('discovery');
    await model.loadState();
    expect(loadDiscoveryMemory).toHaveBeenCalledTimes(1);
  });
  it('supports the legacy voice-only response without claiming physical device evidence', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ sttProvider: 'local', openaiBatchModel: '',
        localWhisperFallbackToOpenAI: false, localWhisperModel: '', localWhisperLanguage: 'bg' }) } as Response);
    const { model, loadMembership } = setup();
    await model.loadState();
    expect(model.state.value?.networkDevices).toEqual([]);
    expect(model.state.value?.voice.provider).toBe('local');
    expect(loadMembership).not.toHaveBeenCalled();
  });
  it('discards delayed snapshots after sign-out instead of restoring obsolete site state', async () => {
    let resolveFetch!: (value: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { resolveFetch = resolve; }));
    const { model, accessToken, loadMembership } = setup();
    const pending = model.loadState();
    accessToken.value = '';
    resolveFetch({ ok: true, status: 200, json: async () => validState } as Response);
    await pending;
    expect(model.state.value).toBeNull();
    expect(loadMembership).not.toHaveBeenCalled();
    expect(model.loadingState.value).toBe(false);
  });
  it('restores the stream on site-selection failure instead of showing the wrong site', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => validState } as Response)
      .mockResolvedValueOnce({ ok: false, status: 403 } as Response);
    const { model, beforeSiteSwitch, onSiteSwitchFailure } = setup();
    await model.loadState();
    await model.switchPortalSite({ target: { value: 'other-site' } } as unknown as Event);
    expect(beforeSiteSwitch).toHaveBeenCalledTimes(1);
    expect(onSiteSwitchFailure).toHaveBeenCalledTimes(1);
    expect(model.state.value?.site.id).toBe('lab');
    expect(model.siteSwitchError.value).toContain('could not be opened');
  });
});
