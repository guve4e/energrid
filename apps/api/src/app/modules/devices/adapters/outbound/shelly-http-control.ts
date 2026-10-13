import { execFile } from 'node:child_process';
import {
  parseDeviceControlBinding,
  type DeviceControlBinding,
} from '@energrid/domain-devices';

type HttpBinding = Extract<DeviceControlBinding, { kind: 'shelly-http' }>;

export function shellyHttpCredentials(
  reference?: string,
): { username: string; password: string } | null {
  if (!reference) return null;
  let configured: unknown;
  try {
    configured = JSON.parse(
      process.env.HOME_SHELLY_HTTP_CREDENTIALS_JSON || '{}',
    );
  } catch {
    throw new Error('Shelly HTTP credentials are not configured correctly.');
  }
  const entry =
    configured && typeof configured === 'object' && !Array.isArray(configured)
      ? (configured as Record<string, unknown>)[reference]
      : null;
  if (!entry || typeof entry !== 'object')
    throw new Error('The server credential reference is not configured.');
  const { username, password } = entry as Record<string, unknown>;
  if (
    username !== 'admin' ||
    typeof password !== 'string' ||
    !password ||
    password.length > 1000 ||
    /[\x00-\x1f]/.test(password)
  )
    throw new Error('The server credential reference is not configured.');
  return { username, password };
}

export class ShellyHttpControl {
  async readOnly(
    binding: HttpBinding,
    method: 'Shelly.GetDeviceInfo' | 'MQTT.GetConfig' | 'MQTT.GetStatus' | 'Switch.GetStatus',
  ): Promise<Record<string, unknown>> {
    const route = parseDeviceControlBinding(binding) as HttpBinding;
    if (!['Shelly.GetDeviceInfo', 'MQTT.GetConfig', 'MQTT.GetStatus', 'Switch.GetStatus'].includes(method))
      throw new Error('Only read-only diagnostic methods are permitted.');
    return this.call(route, method, method === 'Switch.GetStatus' ? { id: route.channel } : {});
  }

  async setSwitch(binding: HttpBinding, on: boolean): Promise<boolean | null> {
    const route = parseDeviceControlBinding(binding) as HttpBinding;
    if (!route.enabled) throw new Error('Switching is disabled.');
    // An address can be reassigned by DHCP. Verify hardware before any write.
    const identity = await this.call(route, 'Shelly.GetDeviceInfo', {});
    if (identity['id'] !== route.physicalId)
      throw new Error(
        'The HTTP address belongs to a different Shelly. No switch command was sent.',
      );
    const written = await this.call(route, 'Switch.Set', {
      id: route.channel,
      on,
    });
    if (typeof written['was_on'] !== 'boolean')
      throw new Error('Shelly did not acknowledge the switch command.');
    try {
      const status = await this.call(route, 'Switch.GetStatus', {
        id: route.channel,
      });
      return status['id'] === route.channel &&
        typeof status['output'] === 'boolean'
        ? status['output']
        : null;
    } catch {
      // A lost verification response is not proof that the preceding write failed.
      return null;
    }
  }

  private async call(
    binding: HttpBinding,
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const credentials = shellyHttpCredentials(binding.credentialRef);
    const args = [
      '--disable',
      '--silent',
      '--show-error',
      '--noproxy',
      '*',
      '--proto',
      '=http,https',
      '--connect-timeout',
      '2',
      '--max-time',
      '4',
      '--max-filesize',
      '65536',
      '--request',
      'POST',
      '--header',
      'Content-Type: application/json',
      '--data',
      JSON.stringify(params),
      '--write-out',
      '\n%{http_code}',
    ];
    // libcurl handles SHA-256 Digest challenges; credentials never reach portal state or logs.
    if (credentials) args.push('--digest', '--config', '-');
    args.push(`${binding.baseUrl}/rpc/${method}`);
    let stdout: string;
    try {
      stdout = await new Promise<string>((resolve, reject) => {
        const child = execFile(
          'curl',
          args,
          { timeout: 5000, maxBuffer: 65536, encoding: 'utf8' },
          (error, output) => {
            if (error)
              reject(new Error('Shelly HTTP request failed or timed out.'));
            else resolve(output);
          },
        );
        child.stdin?.on('error', () => {});
        child.stdin?.end(
          credentials
            ? `user = ${JSON.stringify(`${credentials.username}:${credentials.password}`)}\n`
            : '',
        );
      });
    } catch {
      throw new Error('Shelly HTTP request failed or timed out.');
    }
    const boundary = stdout.lastIndexOf('\n');
    const status = Number(stdout.slice(boundary + 1));
    if (status === 401 || status === 403)
      throw new Error(
        'Shelly HTTP authentication failed; configure a server credential reference.',
      );
    if (
      boundary < 0 ||
      !Number.isInteger(status) ||
      status < 200 ||
      status >= 300
    )
      throw new Error('Shelly HTTP returned an unsuccessful status.');
    let payload: unknown;
    try {
      payload = JSON.parse(stdout.slice(0, boundary));
    } catch {
      throw new Error('Shelly HTTP returned an invalid response.');
    }
    if (
      !payload ||
      typeof payload !== 'object' ||
      Array.isArray(payload) ||
      'error' in payload ||
      'code' in payload
    )
      throw new Error('Shelly HTTP rejected the RPC request.');
    return payload as Record<string, unknown>;
  }
}
