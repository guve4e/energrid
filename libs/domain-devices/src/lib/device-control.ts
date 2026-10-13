export type DeviceControlBinding =
  | {
      kind: 'shelly-mqtt';
      enabled: boolean;
      physicalId: string;
      channel: number;
      topic: string;
    }
  | {
      kind: 'shelly-http';
      enabled: boolean;
      physicalId: string;
      channel: number;
      baseUrl: string;
      credentialRef?: string;
    }
  | { kind: 'generic-mqtt'; enabled: boolean; topic: string };

export interface DeviceControlState {
  status: 'unapproved' | 'read-only' | 'needs-setup' | 'disabled' | 'ready';
  binding: DeviceControlBinding | null;
  reason: string;
}

export function parseDeviceControlBinding(
  value: unknown,
): DeviceControlBinding | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid control binding.');
  const raw = value as Record<string, unknown>;
  if (typeof raw['enabled'] !== 'boolean')
    throw new Error('Control permission must be explicit.');
  const enabled = raw['enabled'];
  const topic = () => {
    const text = raw['topic'];
    if (
      typeof text !== 'string' ||
      !text ||
      text !== text.trim() ||
      text.length > 512 ||
      /[+#\s\x00-\x1f]/.test(text)
    )
      throw new Error('Specify an exact MQTT command topic without wildcards.');
    return text;
  };
  if (raw['kind'] === 'generic-mqtt')
    return { kind: 'generic-mqtt', enabled, topic: topic() };
  if (raw['kind'] !== 'shelly-mqtt' && raw['kind'] !== 'shelly-http')
    throw new Error('Unsupported control transport.');
  const physicalId = raw['physicalId'];
  if (
    typeof physicalId !== 'string' ||
    !/^[a-zA-Z0-9._-]{1,120}$/.test(physicalId)
  )
    throw new Error('A physical Shelly identity is required.');
  const channel = raw['channel'];
  if (
    typeof channel !== 'number' ||
    !Number.isInteger(channel) ||
    channel < 0 ||
    channel > 31
  )
    throw new Error('Specify a relay channel between 0 and 31.');
  if (raw['kind'] === 'shelly-mqtt') {
    const commandTopic = topic();
    if (!commandTopic.endsWith('/rpc'))
      throw new Error('Shelly MQTT command topics must end in /rpc.');
    return {
      kind: 'shelly-mqtt',
      enabled,
      physicalId,
      channel,
      topic: commandTopic,
    };
  }
  const baseUrl = privateShellyBaseUrl(raw['baseUrl']);
  const credentialRef = raw['credentialRef'];
  if (
    credentialRef !== undefined &&
    (typeof credentialRef !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(credentialRef))
  )
    throw new Error('Invalid server credential reference.');
  return {
    kind: 'shelly-http',
    enabled,
    physicalId,
    channel,
    baseUrl,
    ...(credentialRef ? { credentialRef: credentialRef as string } : {}),
  };
}

export function privateShellyBaseUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 250)
    throw new Error('Specify a local Shelly address.');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Specify a valid Shelly address.');
  }
  const parts = url.hostname.split('.');
  const validIp =
    parts.length === 4 &&
    parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
  const [a, b] = parts.map(Number);
  const privateIp =
    validIp &&
    (a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31));
  if (
    !privateIp ||
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error(
      'Use an HTTP(S) origin at a private LAN IPv4 address, without credentials or a path.',
    );
  return url.origin;
}

export interface ControlDeviceIdentity {
  trustStatus: string;
  capabilities: Array<{ actions: string[] }>;
  adapter: { driver: string; target?: string };
  metadata?: Record<string, string | number | boolean>;
}

export function deviceControlState(
  device: ControlDeviceIdentity,
  binding: DeviceControlBinding | null,
): DeviceControlState {
  const result = (
    status: DeviceControlState['status'],
    reason: string,
  ): DeviceControlState => ({ status, reason, binding });
  if (device.trustStatus !== 'approved')
    return result('unapproved', 'Device is not approved.');
  if (
    !device.capabilities.some(
      (c) => c.actions.includes('turn_on') && c.actions.includes('turn_off'),
    )
  )
    return result('read-only', 'No relay switching capability.');
  if (!binding) return result('needs-setup', 'No explicit control route.');
  const shelly = device.adapter.driver.includes('shelly');
  if (binding.kind === 'generic-mqtt') {
    if (shelly)
      return result(
        'needs-setup',
        'Shelly devices require a Shelly control binding.',
      );
  } else {
    const physicalId = device.metadata?.['physicalId'] || device.adapter.target;
    const channel = device.metadata?.['channel'];
    const component = device.metadata?.['component'];
    if (
      !shelly ||
      physicalId !== binding.physicalId ||
      channel !== binding.channel ||
      (component !== undefined && component !== `switch:${binding.channel}`)
    )
      return result(
        'needs-setup',
        'Control identity/channel does not match the approved relay.',
      );
  }
  return binding.enabled
    ? result('ready', 'Explicit control route configured.')
    : result('disabled', 'Switching is disabled.');
}
