export type DeviceHealth = {
  deviceId: string;
  status: 'healthy' | 'degraded' | 'stale';
  reason: string;
  lastSeen: string;
};

export type DashboardNotification = {
  id: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  message: string;
  createdAt: string;
  readAt: string | null;
};

export function deviceHealthNotifications(
  previous: DeviceHealth[],
  current: DeviceHealth[],
  deviceNames: Record<string, string>,
  now = new Date(),
): DashboardNotification[] {
  const previousById = new Map(previous.map((item) => [item.deviceId, item]));

  return current.flatMap((health) => {
    const before = previousById.get(health.deviceId);
    if (!before || before.status === health.status) return [];

    const name = deviceNames[health.deviceId] || health.deviceId;
    const recovered = health.status === 'healthy';
    const createdAt = now.toISOString();
    return [{
      id: `health:${health.deviceId}:${before.status}:${health.status}:${health.lastSeen}`,
      severity: recovered ? 'info' as const : health.status === 'stale' ? 'critical' as const : 'warning' as const,
      title: recovered ? 'Device back online' : health.status === 'stale' ? 'Device not reporting' : 'Device connection delayed',
      message: recovered
        ? `${name} is reporting again.`
        : `${name}: ${health.reason}.`,
      createdAt,
      readAt: null,
    }];
  });
}

export function failedActionNotification(
  deviceId: string,
  deviceName: string,
  action: string,
  reason: string,
  now = new Date(),
): DashboardNotification {
  const createdAt = now.toISOString();
  return {
    id: `action:${deviceId}:${action}:${createdAt}`,
    severity: 'critical',
    title: 'Device command failed',
    message: `${deviceName}: ${action.replaceAll('_', ' ')} failed. ${reason}`,
    createdAt,
    readAt: null,
  };
}

export function mergeNotifications(
  existing: DashboardNotification[],
  incoming: DashboardNotification[],
  limit = 100,
): DashboardNotification[] {
  const seen = new Set(existing.map((item) => item.id));
  return [...incoming.filter((item) => !seen.has(item.id)), ...existing].slice(0, limit);
}
