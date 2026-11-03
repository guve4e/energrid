import { ref, watch, type Ref } from 'vue';
import { authFetch } from '../../auth/auth-client';
import type { PortalState, PortalDevice } from '../../portal-state';
import { canSwitchDevice } from '../../components/devices/device-control';

/** Commands remain server-authorized; verified route evidence only gates UI readiness. */
export function useDeviceActions(options: {
  apiBase: string;
  request?: typeof authFetch;
  accessToken: Ref<string>;
  state: Ref<PortalState | null>;
  onRefresh: () => Promise<void>;
  onLog: (message: string) => void;
}) {
  const { apiBase, accessToken, state, onRefresh, onLog } = options;
  const request = options.request ?? authFetch;
  const verifiedHttpControlRoutes = ref<Record<string, boolean>>({});
  const deviceActionBusy = ref<Record<string, boolean>>({});
  const deviceActionError = ref<Record<string, string>>({});

  function deviceHasAction(device: PortalDevice, action: string) {
    return device.capabilities.some((capability) =>
      capability.actions.includes(action),
    );
  }

  function canToggleDevice(device: PortalDevice) {
    return (
      deviceHasAction(device, 'turn_on') && deviceHasAction(device, 'turn_off')
    );
  }

  function canSendToggle(device: PortalDevice) {
    return (
      canUseDeviceControl(device) &&
      device.state.command?.status !== 'pending'
    );
  }

  function controlRouteIdentityKey(device: PortalDevice): string | null {
    const binding = device.control?.binding;
    return binding?.kind === 'shelly-http'
      ? `${device.tenantId}|${device.siteId}|${device.id}|${binding.baseUrl}`
      : null;
  }

  function canUseDeviceControl(device: PortalDevice): boolean {
    const key = controlRouteIdentityKey(device);
    return device.tenantId === state.value?.tenant.id && device.siteId === state.value?.site.id &&
      canSwitchDevice(device, !key || verifiedHttpControlRoutes.value[key] === true);
  }

  function routeIdentityVerified(device: PortalDevice): boolean {
    const key = controlRouteIdentityKey(device);
    return !key || verifiedHttpControlRoutes.value[key] === true;
  }

  function updateHttpIdentityVerification(result: { tenantId?: string; siteId?: string; deviceId: string; route: string; verified: boolean }) {
    const owner = state.value?.devices?.find(device => device.id === result.deviceId);
    if (!owner || owner.tenantId !== state.value?.tenant.id || owner.siteId !== state.value?.site.id ||
        (result.tenantId && result.tenantId !== owner.tenantId) ||
        (result.siteId && result.siteId !== owner.siteId)) return;
    const key = `${owner.tenantId}|${owner.siteId}|${result.deviceId}|${result.route}`;
    verifiedHttpControlRoutes.value = {
      ...verifiedHttpControlRoutes.value,
      [key]: result.verified,
    };
  }

  async function sendDeviceAction(
    device: PortalDevice,
    action: 'turn_on' | 'turn_off',
  ) {
    if (!canSendToggle(device) || deviceActionBusy.value[device.id]) return;

    const scope = `${device.tenantId}:${device.siteId}:${accessToken.value}`;
    const isCurrent = () => `${state.value?.tenant.id}:${state.value?.site.id}:${accessToken.value}` === scope;
    deviceActionBusy.value = { ...deviceActionBusy.value, [device.id]: true };
    deviceActionError.value = { ...deviceActionError.value, [device.id]: '' };
    onLog(`[device] ${action} requested for ${device.displayName}`);

    try {
      const response = await request(
        `${apiBase}/portal/devices/${encodeURIComponent(device.id)}/actions`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken.value}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ action }),
        },
      );
      const result = await response.json().catch(() => null);
      if (!isCurrent()) return;
      if (!response.ok || !result || result.status === 'failed') {
        throw new Error(result?.message || 'Device action failed');
      }

      onLog(
        `[device] ${action} ${result.status}; affected=${result.affectedDeviceIds?.join(',') || device.id}`,
      );
      await onRefresh();
      if (result?.command?.status === 'pending') {
        await waitForDeviceCommand(device.id, result.command.id, isCurrent);
      }
    } catch (error) {
      if (!isCurrent()) return;
      deviceActionError.value = {
        ...deviceActionError.value,
        [device.id]: error instanceof Error ? error.message : 'Device action failed',
      };
      onLog(
        `[device] ${action} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (isCurrent()) {
        const next = { ...deviceActionBusy.value };
        delete next[device.id];
        deviceActionBusy.value = next;
      }
    }
  }

  async function waitForDeviceCommand(deviceId: string, commandId: string, isCurrent: () => boolean) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await sleep(800);
      if (!isCurrent()) return;
      if (isCurrent()) await onRefresh();
      const device = (state.value?.devices || []).find(
        (candidate) => candidate.id === deviceId,
      );
      const command = device?.state.command;
      if (!command || command.id !== commandId || command.status !== 'pending') {
        return;
      }
    }
  }

  function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }


  // A verification or pending UI state never carries across accounts/sites.
  watch([accessToken, () => state.value?.tenant.id, () => state.value?.site.id], () => {
    verifiedHttpControlRoutes.value = {};
    deviceActionBusy.value = {};
    deviceActionError.value = {};
  });

  return { verifiedHttpControlRoutes, deviceActionBusy, deviceActionError,
    canUseDeviceControl, routeIdentityVerified, canToggleDevice,
    sendDeviceAction, updateHttpIdentityVerification };
}

export type DeviceActionsModel = ReturnType<typeof useDeviceActions>;
