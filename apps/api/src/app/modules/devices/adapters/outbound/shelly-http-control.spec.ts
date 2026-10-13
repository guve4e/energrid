import { execFile } from 'node:child_process';
import {
  ShellyHttpControl,
  shellyHttpCredentials,
} from './shelly-http-control';
import type { DeviceControlBinding } from '@energrid/domain-devices';

jest.mock('node:child_process', () => ({ execFile: jest.fn() }));
const originalEnv = process.env;
const route: Extract<DeviceControlBinding, { kind: 'shelly-http' }> = {
  kind: 'shelly-http',
  enabled: true,
  physicalId: 'shellyplus2pm-001122334455',
  channel: 1,
  baseUrl: 'http://192.168.7.15',
};
const mock = jest.mocked(execFile);
let queue: Array<string | Error>;
let stdin: jest.Mock;
const response = (body: unknown, status = 200) =>
  `${JSON.stringify(body)}\n${status}`;
beforeEach(() => {
  process.env = {};
  stdin = jest.fn();
  queue = [
    response({ id: route.physicalId }),
    response({ was_on: false }),
    response({ id: 1, output: true }),
  ];
  mock.mockReset();
  mock.mockImplementation((_c, _a, _o, cb) => {
    const next = queue.shift();
    if (next instanceof Error) cb(next, '', '');
    else cb(null, next || '', '');
    return { stdin: { end: stdin, on: jest.fn() } } as unknown as ReturnType<
      typeof execFile
    >;
  });
});
afterAll(() => {
  process.env = originalEnv;
});
describe('Shelly HTTP control adapter', () => {
  it('permits only allowlisted read-only diagnostics, even when switching is disabled', async () => {
    queue = [response({ enable: false })];
    expect(await new ShellyHttpControl().readOnly({ ...route, enabled: false }, 'MQTT.GetConfig')).toEqual({ enable: false });
    expect((mock.mock.calls[0][1] as string[]).at(-1)).toBe(`${route.baseUrl}/rpc/MQTT.GetConfig`);
    await expect(new ShellyHttpControl().readOnly(route, 'Switch.Set' as never)).rejects.toThrow('read-only');
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it('reads only the exact verified relay channel during diagnosis', async () => {
    queue = [response({ id: 1, output: true })];
    await new ShellyHttpControl().readOnly({ ...route, enabled: false }, 'Switch.GetStatus');
    const args = mock.mock.calls[0][1] as string[];
    expect(JSON.parse(args[args.indexOf('--data') + 1])).toEqual({ id: 1 });
  });
  it('verifies physical identity before writing the exact channel and reads back state', async () => {
    expect(await new ShellyHttpControl().setSwitch(route, true)).toBe(true);
    const args = mock.mock.calls.map((c) => c[1] as string[]);
    expect(args.map((a) => a.at(-1))).toEqual([
      `${route.baseUrl}/rpc/Shelly.GetDeviceInfo`,
      `${route.baseUrl}/rpc/Switch.Set`,
      `${route.baseUrl}/rpc/Switch.GetStatus`,
    ]);
    expect(JSON.parse(args[1][args[1].indexOf('--data') + 1])).toEqual({
      id: 1,
      on: true,
    });
    expect(args[0]).toEqual(
      expect.arrayContaining([
        '--disable',
        '--noproxy',
        '*',
        '--proto',
        '=http,https',
        '--max-time',
        '4',
      ]),
    );
    expect(args[0]).not.toContain('--location');
    expect(args[0]).not.toContain('--insecure');
  });
  it('does not write if the IP now belongs to another Shelly', async () => {
    queue = [response({ id: 'different-device' })];
    await expect(
      new ShellyHttpControl().setSwitch(route, true),
    ).rejects.toThrow('different Shelly');
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it('uses libcurl digest authentication with private server credentials', async () => {
    process.env.HOME_SHELLY_HTTP_CREDENTIALS_JSON = JSON.stringify({
      kitchen: { username: 'admin', password: 'private-secret' },
    });
    await new ShellyHttpControl().setSwitch(
      { ...route, credentialRef: 'kitchen' },
      true,
    );
    expect(mock.mock.calls[0][1]).toEqual(
      expect.arrayContaining(['--digest', '--config', '-']),
    );
    expect(JSON.stringify(mock.mock.calls)).not.toContain('private-secret');
    expect(stdin).toHaveBeenCalledWith('user = "admin:private-secret"\n');
  });
  it.each([
    '{}',
    '[]',
    'broken',
    JSON.stringify({ key: { username: 'wrong', password: 'secret' } }),
    JSON.stringify({ key: { username: 'admin', password: '' } }),
  ])(
    'rejects missing or invalid secrets without starting a request: %s',
    (config) => {
      process.env.HOME_SHELLY_HTTP_CREDENTIALS_JSON = config;
      expect(() => shellyHttpCredentials('key')).toThrow();
      expect(mock).not.toHaveBeenCalled();
    },
  );
  it.each([
    response({}, 401),
    response({}, 403),
    response({}, 302),
    response({}, 500),
    response({ code: -103, message: 'bad' }),
    'bad\n200',
    response([]),
    response(null),
    '{"id":"x"}\nnot-status',
    new Error('curl --user admin:private-secret failed'),
  ])(
    'handles unsuccessful/invalid responses without exposing upstream details: %j',
    async (value) => {
      queue = [value];
      await expect(
        new ShellyHttpControl().setSwitch(route, true),
      ).rejects.not.toThrow('private-secret');
      expect(mock).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    new Error('lost'),
    response({ id: 0, output: true }),
    response({ id: 1, output: 'true' }),
  ])(
    'keeps unverified writes unconfirmed, without retrying the write: %j',
    async (value) => {
      queue[2] = value;
      expect(await new ShellyHttpControl().setSwitch(route, true)).toBeNull();
      expect(mock).toHaveBeenCalledTimes(3);
    },
  );
  it('preserves a contradictory read-back state instead of claiming success', async () => {
    queue[2] = response({ id: 1, output: false });
    expect(await new ShellyHttpControl().setSwitch(route, true)).toBe(false);
  });
  it('rejects disabled or non-private routes before I/O', async () => {
    await expect(
      new ShellyHttpControl().setSwitch({ ...route, enabled: false }, true),
    ).rejects.toThrow('disabled');
    await expect(
      new ShellyHttpControl().setSwitch(
        { ...route, baseUrl: 'http://169.254.169.254' },
        true,
      ),
    ).rejects.toThrow('private');
    expect(mock).not.toHaveBeenCalled();
  });
  it('does not claim acceptance for a malformed switch acknowledgment', async () => {
    queue[1] = response({});
    await expect(
      new ShellyHttpControl().setSwitch(route, true),
    ).rejects.toThrow('acknowledge');
    expect(mock).toHaveBeenCalledTimes(2);
  });
});
