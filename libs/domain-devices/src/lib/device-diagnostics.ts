export interface DiagnosticProbe<T> {
  status: 'observed' | 'unavailable' | 'auth-required' | 'skipped';
  checkedAt: string;
  value?: T;
}

export interface DeviceDiagnosticCheck {
  id: string;
  label: string;
  status: 'passed' | 'failed' | 'warning' | 'unknown';
  detail: string;
  checkedAt: string;
}

export interface DiagnosticCommand {
  action: string;
  outcome: string;
  requestedAt: string;
  publishedAt: string | null;
  completedAt: string | null;
}

export interface DeviceConnectionEvidence {
  deviceId: string;
  checkedAt: string;
  transport: 'mqtt' | 'http' | 'none';
  controlEnabled: boolean;
  readingsSource: string;
  lastTelemetryAt: string | null;
  identity: DiagnosticProbe<{ matches: boolean }>;
  relay: DiagnosticProbe<{ on: boolean }>;
  mqttConfig: DiagnosticProbe<{
    enabled: boolean | null;
    rpcEnabled: boolean | null;
    notificationsEnabled: boolean | null;
    topic: string | null;
    broker: string | null;
  }>;
  mqttStatus: DiagnosticProbe<{ connected: boolean | null }>;
  expectedTopic: string | null;
  expectedBroker: string;
  listener: 'running' | 'stopped' | 'disabled' | 'unknown';
  sharedTopic: boolean;
  lastCommand: DiagnosticCommand | null;
}

export interface DeviceConnectionReport {
  deviceId: string;
  checkedAt: string;
  readOnly: true;
  code: string;
  title: string;
  summary: string;
  nextAction: string;
  checks: DeviceDiagnosticCheck[];
  currentRelay: { on: boolean; checkedAt: string } | null;
  lastCommand: DiagnosticCommand | null;
}

export function diagnoseDeviceConnection(
  e: DeviceConnectionEvidence,
): DeviceConnectionReport {
  const checks: DeviceDiagnosticCheck[] = [];
  const add = (
    id: string,
    label: string,
    status: DeviceDiagnosticCheck['status'],
    detail: string,
    checkedAt = e.checkedAt,
  ) => {
    checks.push({ id, label, status, detail, checkedAt });
  };
  const matched =
    e.identity.status === 'observed' && e.identity.value?.matches === true;
  const config =
    matched && e.mqttConfig.status === 'observed'
      ? e.mqttConfig.value
      : undefined;
  const connected =
    matched && e.mqttStatus.status === 'observed'
      ? e.mqttStatus.value?.connected
      : null;
  add(
    'identity',
    'Device over HTTP',
    matched
      ? 'passed'
      : e.identity.status === 'observed'
        ? 'failed'
        : 'unknown',
    matched
      ? 'The expected Shelly answered. It is reachable over HTTP.'
      : e.identity.status === 'observed'
        ? 'This address answered as a different device. Further checks were stopped.'
        : e.identity.status === 'auth-required'
          ? 'The device requires HTTP authentication. Reachability and identity could not both be verified.'
          : e.identity.status === 'skipped'
            ? 'No verified local HTTP address is available for this device.'
            : 'No valid identity response. This does not prove the device is offline.',
    e.identity.checkedAt,
  );
  add(
    'route',
    'Control route',
    e.transport === 'none' || !e.controlEnabled ? 'warning' : 'passed',
    e.transport === 'none'
      ? 'No explicit control route is configured.'
      : `${e.transport.toUpperCase()} control is configured; switching is ${e.controlEnabled ? 'allowed' : 'disabled'}.`,
  );
  add(
    'readings',
    'Readings',
    e.lastTelemetryAt ? 'warning' : 'unknown',
    e.lastTelemetryAt
      ? `${e.readingsSource}: last recorded observation ${e.lastTelemetryAt}. This is not a live connectivity check.`
      : `${e.readingsSource}: no readings recorded. Missing readings do not mean offline.`,
  );
  if (matched) {
    add(
      'relay',
      'Relay now',
      e.relay.status === 'observed' && e.relay.value ? 'passed' : 'unknown',
      e.relay.status === 'observed' && e.relay.value
        ? `The relay reports ${e.relay.value.on ? 'On' : 'Off'} now. This does not establish what happened to an earlier command.`
        : 'The relay state could not be read.',
      e.relay.checkedAt,
    );
  }
  if (e.transport === 'mqtt') {
    add(
      'mqtt-enabled',
      'MQTT on device',
      config?.enabled === true
        ? 'passed'
        : config?.enabled === false
          ? 'failed'
          : 'unknown',
      config?.enabled === true
        ? 'MQTT is enabled on the Shelly.'
        : config?.enabled === false
          ? 'MQTT is disabled on the Shelly. It cannot receive MQTT commands while disabled.'
          : 'The device MQTT settings could not be verified.',
      e.mqttConfig.checkedAt,
    );
    add(
      'mqtt-connected',
      'Device broker connection',
      connected === true
        ? 'passed'
        : connected === false
          ? 'failed'
          : 'unknown',
      connected === true
        ? 'The Shelly reports an active MQTT connection.'
        : connected === false
          ? 'The Shelly reports that MQTT is disconnected.'
          : 'The Shelly broker connection could not be verified.',
      e.mqttStatus.checkedAt,
    );
    const actualEndpoint = config?.broker
      ? brokerEndpoint(config.broker)
      : null;
    const expectedEndpoint = brokerEndpoint(e.expectedBroker);
    const brokerMatch =
      actualEndpoint && expectedEndpoint
        ? actualEndpoint === expectedEndpoint
        : null;
    add(
      'broker',
      'Broker address',
      brokerMatch === true
        ? 'passed'
        : brokerMatch === false
          ? 'failed'
          : 'unknown',
      config?.broker != null
        ? `Device: ${config.broker}. Energrid: ${e.expectedBroker}.${brokerMatch ? '' : ' These configured addresses differ; aliases have not been resolved.'}`
        : 'The device broker address could not be verified.',
      e.mqttConfig.checkedAt,
    );
    add(
      'topic',
      'Command topic',
      config?.topic == null
        ? 'unknown'
        : config.topic === e.expectedTopic
          ? 'passed'
          : 'failed',
      config?.topic != null
        ? `Device is configured for ${config.topic}; Energrid uses ${e.expectedTopic || 'no topic'}.`
        : 'The device command topic could not be verified.',
      e.mqttConfig.checkedAt,
    );
    add(
      'rpc',
      'MQTT commands',
      config?.rpcEnabled === true
        ? 'passed'
        : config?.rpcEnabled === false
          ? 'failed'
          : 'unknown',
      config?.rpcEnabled === true
        ? 'RPC over MQTT is enabled.'
        : config?.rpcEnabled === false
          ? 'RPC over MQTT is disabled on the Shelly.'
          : 'RPC over MQTT could not be verified.',
      e.mqttConfig.checkedAt,
    );
    add(
      'notifications',
      'Device status notifications',
      config?.notificationsEnabled === true
        ? 'passed'
        : config?.notificationsEnabled === false
          ? 'warning'
          : 'unknown',
      config?.notificationsEnabled === true
        ? 'MQTT status notifications are enabled.'
        : config?.notificationsEnabled === false
          ? 'Both MQTT status notification options are disabled. Command confirmation can be missing.'
          : 'Status notification settings could not be verified.',
      e.mqttConfig.checkedAt,
    );
    add(
      'listener',
      'Energrid MQTT listener',
      e.listener === 'running'
        ? 'passed'
        : e.listener === 'unknown'
          ? 'unknown'
          : 'failed',
      e.listener === 'running'
        ? 'The listener is running. This alone does not prove this device is sending readings.'
        : `The listener is ${e.listener}.`,
    );
    if (e.sharedTopic)
      add(
        'shared-topic',
        'Shared command topic',
        'warning',
        'Another approved physical device uses this command topic. Verify device-specific routing before testing any switch.',
      );
  }
  if (e.lastCommand)
    add(
      'last-command',
      'Last command',
      e.lastCommand.outcome === 'settled' ? 'passed' : 'warning',
      e.lastCommand.outcome === 'settled'
        ? 'Recorded state confirmation is available in execution history.'
        : `${e.lastCommand.action}: ${e.lastCommand.outcome}. ${e.lastCommand.publishedAt ? 'Publication completed, but publication alone does not prove device receipt.' : 'No completed publication is recorded.'} Current checks cannot reconstruct an unconfirmed past action.`,
      e.lastCommand.completedAt || e.lastCommand.requestedAt,
    );

  let result: [string, string, string, string] = [
    'incomplete',
    'Connection not fully verified',
    'Some evidence is unavailable. Do not assume the device is offline or that a previous command succeeded.',
    'Check the unavailable items and run this check again. No switch retry is performed.',
  ];
  const issue = (id: string) =>
    checks.find((c) => c.id === id)?.status === 'failed';
  if (e.identity.status === 'observed' && !matched)
    result = [
      'identity-mismatch',
      'The address belongs to another device',
      'The expected hardware identity was not returned. No command or configuration change was made.',
      'Check the local address and hardware mapping before allowing control.',
    ];
  else if (e.transport === 'mqtt' && config?.enabled === false)
    result = [
      'mqtt-disabled',
      'Device reachable, but MQTT is disabled',
      'The Shelly answers over HTTP, but its configured MQTT control route cannot receive commands while MQTT is disabled.',
      'Enable MQTT in this Shelly’s settings with the intended broker, or deliberately configure HTTP control instead. Then check again.',
    ];
  else if (e.transport === 'mqtt' && issue('broker'))
    result = [
      'broker-mismatch',
      'Broker addresses differ',
      'The device and Energrid name different broker endpoints. They may be aliases, but a shared broker has not been verified.',
      'Verify both endpoints refer to the same broker before testing control.',
    ];
  else if (e.transport === 'mqtt' && issue('topic'))
    result = [
      'topic-mismatch',
      'The command topic does not match',
      'Energrid is configured to send to a different topic than this Shelly reports.',
      'Correct the control topic to match this device’s MQTT prefix followed by /rpc.',
    ];
  else if (e.transport === 'mqtt' && config?.rpcEnabled === false)
    result = [
      'rpc-disabled',
      'MQTT commands are disabled on the device',
      'MQTT may be connected, but RPC commands are disabled in the Shelly settings.',
      'Enable RPC over MQTT on this Shelly, or deliberately choose HTTP control.',
    ];
  else if (e.transport === 'mqtt' && connected === false)
    result = [
      'mqtt-disconnected',
      'Device reachable, MQTT disconnected',
      'The Shelly answers over HTTP but reports no active MQTT connection.',
      'Check the Shelly broker address, credentials and network connection. No retry or settings change was made.',
    ];
  else if (
    e.transport === 'mqtt' &&
    ['stopped', 'disabled'].includes(e.listener)
  )
    result = [
      'listener-unavailable',
      'Energrid is not listening for MQTT updates',
      'The configured listener is not running. Commands cannot be confirmed from MQTT telemetry here.',
      'Restore the Energrid MQTT listener and check again.',
    ];
  else if (
    [e.identity, e.relay, e.mqttConfig, e.mqttStatus].some(
      (probe) => probe.status === 'auth-required',
    )
  )
    result = [
      'authentication-required',
      'HTTP authentication is required',
      'The HTTP check was refused. The MQTT connection has not been verified by this check.',
      'Configure a server-side credential reference for authenticated HTTP checks. Do not put passwords in URLs or MQTT topics.',
    ];
  else if (e.transport === 'none' || !e.controlEnabled)
    result = [
      'control-disabled',
      matched
        ? 'Device reachable; control is not enabled'
        : 'Control is not enabled',
      'Approval and permission to switch are separate. This check grants neither.',
      'Review the control route and permission before testing a switch.',
    ];
  else if (e.transport === 'mqtt' && config?.notificationsEnabled === false)
    result = [
      'notifications-disabled',
      'Status notifications are disabled',
      'The device is configured not to send either MQTT status notification format. A command may execute without confirmation here.',
      'Enable supported status notifications in the Shelly settings, then check telemetry.',
    ];
  else if (
    matched &&
    (e.transport === 'http'
      ? e.relay.status === 'observed'
      : [
          'mqtt-enabled',
          'mqtt-connected',
          'broker',
          'topic',
          'rpc',
          'notifications',
          'listener',
        ].every((id) => checks.find((c) => c.id === id)?.status === 'passed'))
  )
    result = e.sharedTopic
      ? [
          'shared-topic',
          'Connection checks passed; verify shared routing',
          'The device connection is configured, but another physical device shares its command topic.',
          'Verify device-specific routing before any switch test.',
        ]
      : [
          'checks-passed',
          'Connection checks passed',
          'The read-only checks passed. No switching command was sent, so command delivery has not been tested.',
          'Use the device controls only when you are ready to operate this exact relay.',
        ];

  return {
    deviceId: e.deviceId,
    checkedAt: e.checkedAt,
    readOnly: true,
    code: result[0],
    title: result[1],
    summary: result[2],
    nextAction: result[3],
    checks,
    currentRelay:
      matched && e.relay.status === 'observed' && e.relay.value
        ? { on: e.relay.value.on, checkedAt: e.relay.checkedAt }
        : null,
    lastCommand: e.lastCommand,
  };
}

function brokerEndpoint(value: string): string | null {
  try {
    const url = new URL(value.includes('://') ? value : `mqtt://${value}`);
    if (
      !['mqtt:', 'mqtts:', 'ssl:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      !url.hostname ||
      url.search ||
      url.hash ||
      (url.pathname && url.pathname !== '/')
    )
      return null;
    return `${url.protocol === 'ssl:' ? 'mqtts:' : url.protocol}//${url.hostname.toLowerCase()}:${url.port || (url.protocol === 'mqtt:' ? '1883' : '8883')}`;
  } catch {
    return null;
  }
}
