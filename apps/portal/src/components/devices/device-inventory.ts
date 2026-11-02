import { canSwitchDevice, type ControlSetupDevice } from './device-control';
import { relayStateFreshness } from './device-detail-capabilities';

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

export interface PhysicalInventoryGroup<T extends InventoryDevice> {
  key: string;
  physicalInventoryId?: string;
  physicalId?: string;
  label: string;
  components: T[];
}

export function applyEnrollmentPhysicalAssignment<T extends InventoryDevice>(
  device: T,
  assignments: readonly { physicalDeviceId: string; componentKey?: string }[],
): T {
  if (!assignments.length) return withoutPhysicalInventoryAssignment(device);

  const component = typeof device.metadata?.component === 'string'
    ? device.metadata.component
    : undefined;
  const componentAssignments = component
    ? assignments.filter(assignment => assignment.componentKey === component)
    : assignments.filter(assignment => !assignment.componentKey);
  const selectedAssignments = componentAssignments.length
    ? componentAssignments
    : assignments.every(assignment => !assignment.componentKey)
      ? assignments
      : [];
  const physicalIds = [...new Set(selectedAssignments.map(assignment => assignment.physicalDeviceId))];
  if (physicalIds.length !== 1) return withoutPhysicalInventoryAssignment(device);

  const currentId = typeof device.metadata?.physicalInventoryId === 'string'
    ? device.metadata.physicalInventoryId
    : undefined;
  if (currentId && currentId !== physicalIds[0]) return withoutPhysicalInventoryAssignment(device);

  return {
    ...device,
    metadata: { ...device.metadata, physicalInventoryId: physicalIds[0] },
  };
}

function withoutPhysicalInventoryAssignment<T extends InventoryDevice>(device: T): T {
  if (!device.metadata || !('physicalInventoryId' in device.metadata)) return device;
  const { physicalInventoryId: _ignored, ...metadata } = device.metadata;
  return { ...device, metadata };
}

/**
 * Group logical installations only when the authoritative Physical Inventory
 * assignment is present. Protocol identity claims alone are not enough to
 * merge records into one physical device.
 */
export function groupInventoryDevices<T extends InventoryDevice>(devices: T[]): PhysicalInventoryGroup<T>[] {
  const groups = new Map<string, PhysicalInventoryGroup<T>>();
  for (const device of devices) {
    const physicalInventoryId = typeof device.metadata?.physicalInventoryId === 'string'
      ? device.metadata.physicalInventoryId.trim()
      : '';
    const owner = `${device.tenantId || ''}\u0000${device.siteId || ''}`;
    const key = physicalInventoryId
      ? `${owner}\u0000inventory:${physicalInventoryId}`
      : `${owner}\u0000logical:${device.id}`;
    const group = groups.get(key) || {
      key,
      ...(physicalInventoryId ? { physicalInventoryId } : {}),
      ...(typeof device.metadata?.physicalId === 'string' ? { physicalId: device.metadata.physicalId } : {}),
      label: physicalDeviceLabel(device),
      components: [],
    };
    group.components.push(device);
    if (isMoreUsefulPhysicalLabel(device, group.label)) group.label = physicalDeviceLabel(device);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function physicalComponentLabel(device: InventoryDevice): string {
  const component = typeof device.metadata?.component === 'string' ? device.metadata.component : '';
  const switchMatch = /^switch:(\d+)$/.exec(component);
  if (switchMatch) return `Switch ${Number(switchMatch[1]) + 1}`;
  const meterMatch = /^em1:(\d+)$/.exec(component);
  if (meterMatch) return `Energy meter ${Number(meterMatch[1]) + 1}`;
  return component || 'Component';
}

export function inventoryComponentDisplayName(device: InventoryDevice): string {
  const physicalId = String(device.metadata?.physicalId || '');
  const name = device.displayName.trim();
  if (!name || name === device.id || (physicalId && name.toLowerCase().startsWith(physicalId.toLowerCase())))
    return physicalComponentLabel(device);
  return name;
}

function physicalDeviceLabel(device: InventoryDevice): string {
  const physicalId = String(device.metadata?.physicalId || '').toLowerCase();
  if (physicalId.startsWith('shellypro2pm-')) return 'Shelly Pro 2PM';
  if (physicalId.startsWith('shellyplus1-')) return 'Shelly Plus 1';
  if (device.displayName && device.displayName !== device.id && !device.displayName.startsWith(`${physicalId}:`))
    return device.displayName.replace(/\s+switch:\d+$/i, '');
  return device.displayName || 'Physical device';
}

function isMoreUsefulPhysicalLabel(device: InventoryDevice, current: string): boolean {
  const label = physicalDeviceLabel(device);
  return label !== current && !/^shelly[a-z0-9._-]+(?::switch:\d+)?$/i.test(label);
}

export function inventoryConnectionStatus(device: Pick<InventoryDevice, 'state'>, now = Date.now()): string {
  const freshness = relayStateFreshness(
    device.state.status,
    device.state.observedAt ?? null,
    now,
  );
  return freshness === 'fresh' ? 'online' : freshness;
}

export function formatDeviceObservationTime(value: string | null | undefined): string {
  if (!value) return 'unknown';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function isExampleDevice(device: ControlSetupDevice): boolean {
  return (
    device.metadata?.simulated === true ||
    device.adapter.protocol === 'simulated'
  );
}

export function needsControlSetup<T extends ControlSetupDevice>(
  device: T,
  isControllable: (device: T) => boolean = canSwitchDevice,
): boolean {
  return (
    device.trustStatus === 'approved' &&
    device.capabilities.some(
      (c) => c.actions.includes('turn_on') && c.actions.includes('turn_off'),
    ) &&
    !isControllable(device)
  );
}

export function filterInventoryDevices<T extends InventoryDevice>(
  devices: T[],
  filters: InventoryFilters,
  isControllable: (device: T) => boolean = canSwitchDevice,
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
      if (filters.status === 'controllable' && !isControllable(device))
        return false;
      if (filters.status === 'needs_setup' && !needsControlSetup(device, isControllable))
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
