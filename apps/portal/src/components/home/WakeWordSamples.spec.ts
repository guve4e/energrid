import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import WakeWordSamples from './WakeWordSamples.vue';
import { startSampleRecording, supportedSampleLabels } from './wake-word-sample-categories';

let page: ReturnType<typeof mount> | undefined;
const nativeBridge = {
  getSamples: () => JSON.stringify({ positive: 61, negative: 8, status: 'idle', dailyScheduleEnabled: false }),
  getRecorderCapabilities: () => JSON.stringify({ backgroundSessions: true, segmentedWav: true, backgroundCategories: ['tv', 'english_tv', 'conversation', 'household', 'mixed'] }),
  getUploadStatus: () => JSON.stringify({ recorded: 28, uploaded: 1, pending: 27, failed: 0, serverStatus: 'connected', configured: true }),
  startSampleRecording: vi.fn(),
  stopSampleRecording: vi.fn(),
  enableDailySchedule: vi.fn(),
  disableDailySchedule: vi.fn(),
  exportSamples: vi.fn(),
};

afterEach(() => {
  page?.unmount();
  page = undefined;
  nativeBridge.startSampleRecording.mockClear();
  nativeBridge.stopSampleRecording.mockClear();
  nativeBridge.enableDailySchedule.mockClear();
  nativeBridge.disableDailySchedule.mockClear();
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

  it('shows durable upload queue counters and server state', async () => {
    page = mount(WakeWordSamples, { props: { recorderBridge: nativeBridge } });
    await Promise.resolve();
    expect(page.text()).toContain('28 recorded');
    expect(page.text()).toContain('1 uploaded');
    expect(page.text()).toContain('27 pending');
    expect(page.text()).toContain('connected');
  });

  it('requires recording consent before enabling the daily schedule', async () => {
    page = mount(WakeWordSamples, { props: { recorderBridge: nativeBridge } });
    const category = page.get('select[aria-label="Recording label"]');
    await category.setValue('background:tv');
    const schedule = page.findAll('button').find((button) => button.text().includes('Enable daily schedule'))!;
    expect((schedule.element as HTMLButtonElement).disabled).toBe(true);
    await page.get('.research-consent input').setValue(true);
    expect((schedule.element as HTMLButtonElement).disabled).toBe(false);
    await schedule.trigger('click');
    expect(nativeBridge.enableDailySchedule).toHaveBeenCalledWith('background:tv');
  });

  it('keeps capture active while a five-minute segment is finalized', async () => {
    page = mount(WakeWordSamples, { props: { recorderBridge: {
      ...nativeBridge,
      getSamples: () => JSON.stringify({ positive: 0, negative: 1, status: 'recording', category: 'background:tv' }),
    } } });
    window.dispatchEvent(new CustomEvent('energrid-wake-samples', { detail: { status: 'segment_saved', category: 'background:tv' } }));
    await Promise.resolve();
    expect(page.text()).toContain('Stop recording');
    expect(page.text()).toContain('RESEARCH RECORDING ACTIVE');
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
