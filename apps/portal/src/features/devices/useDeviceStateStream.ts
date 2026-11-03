import { onScopeDispose, ref, watch, type Ref } from 'vue';
import { authFetch } from '../../auth/auth-client';
import type { PortalState } from '../../portal-state';
import {
  applyDeviceOperationalStateEvent,
  takePortalSseFrames,
  type DeviceOperationalStateChangedEvent,
} from '../../device-state-events';

export function useDeviceStateStream(options: {
  apiBase: string;
  request?: typeof authFetch;
  accessToken: Ref<string>;
  activePage: Ref<string>;
  state: Ref<PortalState | null>;
}) {
  const { apiBase, accessToken, activePage, state } = options;
  const request = options.request ?? authFetch;
  const deviceStateStreamStatus = ref<'idle' | 'connecting' | 'syncing' | 'connected' | 'reconnecting'>('idle');
  const deviceStateClock = ref(Date.now());
  let deviceStateStreamController: AbortController | undefined;
  let deviceStateStreamGeneration = 0;
  let deviceStateReconnectTimer: number | undefined;
  let deviceStateReconnectDelayResolve: (() => void) | undefined;

  function stopDeviceStateStream() {
    deviceStateStreamGeneration += 1;
    deviceStateStreamController?.abort();
    deviceStateStreamController = undefined;
    if (deviceStateReconnectTimer !== undefined) window.clearTimeout(deviceStateReconnectTimer);
    deviceStateReconnectTimer = undefined;
    deviceStateReconnectDelayResolve?.();
    deviceStateReconnectDelayResolve = undefined;
    deviceStateStreamStatus.value = 'idle';
  }

  function isCurrentDeviceStateStream(generation: number, tenantId: string, siteId: string) {
    return generation === deviceStateStreamGeneration && !!accessToken.value &&
      ['devices', 'home'].includes(activePage.value) &&
      state.value?.tenant.id === tenantId && state.value?.site.id === siteId;
  }

  function isOperationalStateEvent(value: unknown): value is DeviceOperationalStateChangedEvent {
    if (!value || typeof value !== 'object') return false;
    const event = value as Partial<DeviceOperationalStateChangedEvent>;
    return typeof event.sequence === 'number' && Number.isSafeInteger(event.sequence) && event.sequence > 0 &&
      typeof event.tenantId === 'string' &&
      typeof event.siteId === 'string' && typeof event.deviceId === 'string' &&
      !!event.state && typeof event.state === 'object';
  }

  async function reconcileDeviceStateSnapshot(tenantId: string, siteId: string, generation: number) {
    const response = await request(`${apiBase}/portal/state`, {
      headers: { Authorization: `Bearer ${accessToken.value}` },
    });
    if (!response.ok) throw new Error('Device state reconciliation failed');
    const snapshot = await response.json() as PortalState;
    if (snapshot.tenant.id !== tenantId || snapshot.site.id !== siteId ||
        !isCurrentDeviceStateStream(generation, tenantId, siteId)) {
      throw new Error('The active Portal site changed during device state reconciliation');
    }
    state.value = snapshot;
  }

  async function runDeviceStateStream(generation: number, tenantId: string, siteId: string) {
    let retryDelay = 500;
    while (isCurrentDeviceStateStream(generation, tenantId, siteId)) {
      const controller = new AbortController();
      deviceStateStreamController = controller;
      deviceStateStreamStatus.value = retryDelay === 500 ? 'connecting' : 'reconnecting';
      let watchdog: number | undefined;
      const armWatchdog = () => {
        if (watchdog !== undefined) window.clearTimeout(watchdog);
        watchdog = window.setTimeout(() => controller.abort(), 45_000);
      };
      try {
        const response = await request(`${apiBase}/portal/devices/state/events`, {
          headers: { Accept: 'text/event-stream', Authorization: `Bearer ${accessToken.value}` },
          signal: controller.signal,
        });
        if (!response.ok || !response.body) throw new Error(`Device state stream unavailable (${response.status})`);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let snapshotReady = false;
        let lastReceivedSequence = 0;
        let lastAppliedSequence = 0;
        let pendingEventOverflow = false;
        const pendingEvents: DeviceOperationalStateChangedEvent[] = [];
        armWatchdog();
        while (isCurrentDeviceStateStream(generation, tenantId, siteId)) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error('Device state stream closed');
          buffer += decoder.decode(chunk.value, { stream: true });
          if (buffer.length > 65_536) throw new Error('Device state stream frame exceeded its limit');
          const parsed = takePortalSseFrames(buffer);
          buffer = parsed.remainder;
          for (const frame of parsed.frames) {
            armWatchdog();
            if (frame.event === 'heartbeat') {
              const heartbeat = frame.data as { tenantId?: string; siteId?: string };
              if (heartbeat?.tenantId === tenantId && heartbeat.siteId === siteId) deviceStateClock.value = Date.now();
            } else if (frame.event === 'ready') {
              const ready = frame.data as { tenantId?: string; siteId?: string };
              if (ready?.tenantId !== tenantId || ready.siteId !== siteId) throw new Error('Device state stream site mismatch');
              deviceStateStreamStatus.value = 'syncing';
              await reconcileDeviceStateSnapshot(tenantId, siteId, generation);
              for (const event of pendingEvents) {
                if (event.sequence <= lastAppliedSequence) continue;
                applyDeviceOperationalStateEvent(state.value!, event, lastAppliedSequence);
                lastAppliedSequence = event.sequence;
              }
              pendingEvents.length = 0;
              if (pendingEventOverflow) {
                await reconcileDeviceStateSnapshot(tenantId, siteId, generation);
                lastAppliedSequence = lastReceivedSequence;
                pendingEventOverflow = false;
              }
              snapshotReady = true;
              deviceStateClock.value = Date.now();
              deviceStateStreamStatus.value = 'connected';
            } else if (frame.event === 'device-state-changed' && isOperationalStateEvent(frame.data)) {
              const event = frame.data;
              if (event.tenantId !== tenantId || event.siteId !== siteId) continue;
              if (event.sequence <= lastReceivedSequence) continue;
              lastReceivedSequence = event.sequence;
              if (!snapshotReady) {
                if (pendingEvents.length < 256) pendingEvents.push(event);
                else pendingEventOverflow = true;
              } else if (state.value) {
                applyDeviceOperationalStateEvent(state.value, event, lastAppliedSequence);
                lastAppliedSequence = event.sequence;
              }
            }
          }
        }
        await reader.cancel();
      } catch {
        if (watchdog !== undefined) window.clearTimeout(watchdog);
        if (!isCurrentDeviceStateStream(generation, tenantId, siteId)) break;
        deviceStateStreamStatus.value = 'reconnecting';
        await new Promise<void>(resolve => {
          deviceStateReconnectDelayResolve = resolve;
          deviceStateReconnectTimer = window.setTimeout(resolve, retryDelay);
        });
        deviceStateReconnectTimer = undefined;
        deviceStateReconnectDelayResolve = undefined;
        retryDelay = Math.min(retryDelay * 2, 15_000);
        continue;
      } finally {
        if (watchdog !== undefined) window.clearTimeout(watchdog);
        if (deviceStateStreamController === controller) deviceStateStreamController = undefined;
      }
    }
  }

  function syncDeviceStateStream() {
    stopDeviceStateStream();
    if (!accessToken.value || !state.value || !['devices', 'home'].includes(activePage.value)) return;
    const tenantId = state.value.tenant.id;
    const siteId = state.value.site.id;
    const generation = deviceStateStreamGeneration;
    void runDeviceStateStream(generation, tenantId, siteId);
  }

  watch([accessToken, activePage, () => state.value?.tenant.id, () => state.value?.site.id], syncDeviceStateStream);
    onScopeDispose(stopDeviceStateStream);


  return { deviceStateStreamStatus, deviceStateClock, stopDeviceStateStream, syncDeviceStateStream };
}
