import { describe, expect, it } from 'vitest';
import { ref } from 'vue';
import { mount } from '@vue/test-utils';
import DeviceIntelligencePanel from './DeviceIntelligencePanel.vue';

describe('Device Intelligence panel', () => {
  it('preserves optional AI status and closes without changing device enrollment', async () => {
    const selected = ref<string | null>('device-1');
    const wrapper = mount(DeviceIntelligencePanel, {
      props: { model: {
        selectedAiDeviceId: selected,
        selectedAiDevice: ref({ hostname: 'lab-relay', ipAddress: '172.30.250.3' }),
        selectedAiError: ref(null),
        llmProviderAvailability: ref({ available: false, provider: 'local', reasonCode: 'disabled' }),
        aiInvestigating: ref({}),
      } as any },
      global: { stubs: { InvestigationHistory: true, MqttProfileReview: true, InvestigationReport: true } },
    });
    expect(wrapper.text()).toContain('lab-relay');
    expect(wrapper.text()).toContain('AI investigation unavailable');
    await wrapper.find('button.secondary').trigger('click');
    expect(selected.value).toBeNull();
  });
});
