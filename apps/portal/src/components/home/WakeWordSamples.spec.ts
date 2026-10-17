import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import WakeWordSamples from './WakeWordSamples.vue';
import { startSampleRecording, supportedSampleLabels } from './wake-word-sample-categories';

let page: ReturnType<typeof mount> | undefined;
const nativeBridge = {
  getSamples: () => JSON.stringify({ positive: 61, negative: 8, status: 'idle' }),
  getRecorderCapabilities: () => JSON.stringify({ backgroundSessions: true, segmentedWav: true, backgroundCategories: ['tv', 'english_tv', 'conversation', 'household', 'mixed'] }),
  startSampleRecording: vi.fn(),
  stopSampleRecording: vi.fn(),
  exportSamples: vi.fn(),
};

afterEach(() => {
  page?.unmount();
  page = undefined;
  nativeBridge.startSampleRecording.mockClear();
  nativeBridge.stopSampleRecording.mockClear();
});

describe('wake-word sample categories', () => {
  it('passes the selected English TV label unchanged to native capture', () => {
    startSampleRecording(nativeBridge, 'background:english_tv');
    expect(nativeBridge.startSampleRecording).toHaveBeenCalledWith('background:english_tv');
  });

  it('keeps Bulgarian TV mapped to its own category', () => {
    startSampleRecording(nativeBridge, 'background:tv');
    expect(nativeBridge.startSampleRecording).toHaveBeenCalledWith('background:tv');
  });

  it('shows English TV only when native recorder capabilities advertise it', () => {
    expect(supportedSampleLabels(['tv', 'english_tv'])).toContain('english_tv');
    expect(supportedSampleLabels(undefined)).not.toContain('english_tv');
  });

  it('hides English TV when an older installed native app does not advertise that category', async () => {
    page = mount(WakeWordSamples, { props: { recorderBridge: {
      ...nativeBridge,
      getRecorderCapabilities: () => JSON.stringify({ backgroundSessions: true, segmentedWav: true }),
    } } });

    expect(page.find('option[value="background:english_tv"]').exists()).toBe(false);
    expect(page.find('option[value="background:tv"]').exists()).toBe(true);
  });
});
