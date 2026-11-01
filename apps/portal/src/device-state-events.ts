export interface PortalSseFrame {
  event: string;
  data: unknown;
}

export interface DeviceOperationalStateChangedEvent {
  sequence: number;
  tenantId: string;
  siteId: string;
  deviceId: string;
  state: {
    values: Record<string, number | boolean | string | null>;
    observedAt: string | null;
    source: string;
    status: string;
    observerReachability?: string;
  };
}

export interface PortalDeviceStateEnvelope<T> {
  tenant: { id: string };
  site: { id: string };
  devices?: T[];
}

export function takePortalSseFrames(buffer: string): { frames: PortalSseFrame[]; remainder: string } {
  const frames: PortalSseFrame[] = [];
  let remainder = buffer;
  while (true) {
    const match = /\r?\n\r?\n/.exec(remainder);
    if (!match || match.index === undefined) break;
    const raw = remainder.slice(0, match.index);
    remainder = remainder.slice(match.index + match[0].length);
    let event = 'message';
    const data: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    if (data.length) {
      try { frames.push({ event, data: JSON.parse(data.join('\n')) as unknown }); }
      catch { /* Ignore malformed frames; the next authoritative snapshot reconciles state. */ }
    }
  }
  return { frames, remainder };
}

export function applyDeviceOperationalStateEvent<
  T extends { id: string; tenantId: string; siteId: string; state: DeviceOperationalStateChangedEvent['state'] },
  S extends PortalDeviceStateEnvelope<T>,
>(snapshot: S, event: DeviceOperationalStateChangedEvent, lastSequence = 0): boolean {
  if (event.tenantId !== snapshot.tenant.id || event.siteId !== snapshot.site.id) return false;
  if (!Number.isSafeInteger(event.sequence) || event.sequence <= lastSequence ||
      !event.deviceId || !event.state || typeof event.state.status !== 'string' ||
      typeof event.state.source !== 'string' || !event.state.values ||
      (event.state.observedAt !== null && !Number.isFinite(Date.parse(event.state.observedAt)))) return false;
  const devices = snapshot.devices || [];
  const index = devices.findIndex(device => device.id === event.deviceId &&
    device.tenantId === event.tenantId && device.siteId === event.siteId);
  if (index < 0) return false;
  const current = devices[index];
  const incomingAt = event.state.observedAt ? Date.parse(event.state.observedAt) : Number.NaN;
  const currentAt = current.state.observedAt ? Date.parse(current.state.observedAt) : Number.NaN;
  if (Number.isFinite(currentAt) && (!Number.isFinite(incomingAt) || incomingAt < currentAt)) return false;
  current.state = { ...event.state };
  return true;
}
