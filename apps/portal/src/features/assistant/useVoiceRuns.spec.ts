import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { authFetch } from '../../auth/auth-client';
import { useVoiceRuns } from './useVoiceRuns';

vi.mock('../../auth/auth-client', () => ({ authFetch: vi.fn() }));
const request = vi.mocked(authFetch);
let wrapper: ReturnType<typeof mount> | undefined;
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.resetAllMocks(); });
describe('voice history session scope', () => {
  it('discards an old response after a token change', async () => {
    const token = ref('site-user-a');
    let runs!: ReturnType<typeof useVoiceRuns>;
    wrapper = mount(defineComponent({ setup() {
      runs = useVoiceRuns({ apiBase: '', accessToken: token });
      return () => h('div');
    } }));
    let complete!: (response: Response) => void;
    request.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const first = runs.loadVoiceRuns();
    expect(runs.voiceRunsLoading.value).toBe(true);
    token.value = 'site-user-b';
    await nextTick();
    complete({ ok: true, json: async () => ({ runs: [{ id: 'old' }] }) } as Response);
    await first;
    expect(runs.voiceRuns.value).toEqual([]);
    expect(runs.voiceRunsLoading.value).toBe(false);
    request.mockResolvedValueOnce({ ok: true, json: async () => ({ runs: [{ id: 'new' }] }) } as Response);
    await runs.loadVoiceRuns();
    expect(runs.voiceRuns.value[0]?.id).toBe('new');
  });
});
