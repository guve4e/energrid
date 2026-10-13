import { canSwitchDevice, type ControlSetupDevice } from './device-control';

export interface InventoryDevice extends ControlSetupDevice {
  displayName: string;
  kind: string;
  zoneId: string;
  zoneName: string;
  capabilities: Array<{ kind: string; actions: string[] }>;
  adapter: ControlSetupDevice['adapter'] & {
    configured?: boolean;
    transport?: string;
    commandTopic?: string;
    telemetryTopic?: string;
  };
  state: { status: string; observedAt?: string | null };
}

export interface InventoryFilters {
  approval: 'approved' | 'discovered';
  source: string;
  search: string;
  capability: string;
  zone: string;
  status: string;
}

export function inventoryConnectionStatus(device: Pick<InventoryDevice, 'state'>): string {
  return device.state.observedAt === null ? 'unknown' : device.state.status;
}

export function isExampleDevice(device: ControlSetupDevice): boolean {
  return (
    device.metadata?.simulated === true ||
    device.adapter.protocol === 'simulated'
  );
}

export function needsControlSetup(device: ControlSetupDevice): boolean {
  return (
    device.trustStatus === 'approved' &&
    device.capabilities.some(
      (c) => c.actions.includes('turn_on') && c.actions.includes('turn_off'),
    ) &&
    !canSwitchDevice(device)
  );
}

export function filterInventoryDevices<T extends InventoryDevice>(
  devices: T[],
  filters: InventoryFilters,
): T[] {
  const search = filters.search.trim().toLowerCase();
  return devices
    .filter((device) => {
      if (device.trustStatus !== filters.approval) return false;
      if (filters.source === 'site' && isExampleDevice(device)) return false;
      if (filters.source === 'examples' && !isExampleDevice(device))
        return false;
      if (
        filters.capability !== 'all' &&
        !device.capabilities.some((c) => c.kind === filters.capability)
      )
        return false;
      if (filters.zone !== 'all' && device.zoneId !== filters.zone)
        return false;
      if (
        ['online', 'offline'].includes(filters.status) &&
        inventoryConnectionStatus(device) !== filters.status
      )
        return false;
      if (filters.status === 'controllable' && !canSwitchDevice(device))
        return false;
      if (filters.status === 'needs_setup' && !needsControlSetup(device))
        return false;
      if (!search) return true;
      return [
        device.id,
        device.displayName,
        device.zoneName,
        device.kind,
        device.adapter.driver,
        device.adapter.protocol,
        device.adapter.transport,
        device.adapter.target,
        device.adapter.commandTopic,
        device.adapter.telemetryTopic,
        device.metadata?.mqttCommandTopic,
        device.metadata?.physicalId,
        device.state.status,
        device.memberDeviceIds?.join(' '),
        device.capabilities.map((c) => c.kind).join(' '),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(search);
    })
    .sort(
      (a, b) =>
        a.zoneName.localeCompare(b.zoneName) ||
        a.displayName.localeCompare(b.displayName),
    );
}
