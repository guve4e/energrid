import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { mount } from '@vue/test-utils';
import MqttProfileReview from './MqttProfileReview.vue';

describe('MQTT observation profile review', () => {
  it('only previews a proposal when the user explicitly requests it', async () => {
    const preview = vi.fn();
    const wrapper = mount(MqttProfileReview, { props: { model: {
      selectedAiDeviceId: ref('lab-relay'), mqttProfileLoading: ref({}),
      mqttProfileRunning: ref({}), mqttProfileErrors: ref({}), mqttProfileHistory: ref({}),
      mqttProfileSelected: ref({}), selectedMqttProfile: ref(null),
      kitchenCaptureStatus: ref(null), kitchenCaptureError: ref(null), kitchenCaptureLoading: ref(false),
      loadMqttProfileHistory: vi.fn(), previewMqttProfile: preview,
      investigateMqttProfile: vi.fn(), loadKitchenCaptureStatus: vi.fn(),
    } as any } });
    expect(wrapper.text()).toContain('Read-only investigation');
    expect(preview).not.toHaveBeenCalled();
    await wrapper.findAll('button').find(button => button.text().includes('Preview replay'))!.trigger('click');
    expect(preview).toHaveBeenCalledWith('lab-relay');
  });
});
