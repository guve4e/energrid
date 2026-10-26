jest.mock('@letta-ai/letta-agent-sdk', () => ({
  LettaAgentClient: class {
    createAgent = jest.fn();
    resumeSession = jest.fn();
  },
}));

import { LettaHouseAgentAdapter } from './letta-house-agent.adapter';

describe('LettaHouseAgentAdapter measurement tools', () => {
  it('keeps the existing tools and exposes a scoped room-and-metric observation tool', async () => {
    const scope = { tenantId: 'tenant-demo', siteId: 'site-home' };
    const measurement = {
      status: 'measurement', deviceId: 'device:upstream-lan:esp8266:324864',
      metric: 'temperature', value: 19.4, unit: 'Cel',
      sourceId: 'energrid-http-status', observedAt: '2026-10-24T06:00:00.000Z',
      freshness: 'fresh', ageSeconds: 2, freshnessLimitSeconds: 60,
    };
    const intelligence = {
      readRoomMeasurement: jest.fn().mockResolvedValue(measurement),
    };
    const adapter = new LettaHouseAgentAdapter(
      {} as never, {} as never, {} as never, intelligence as never, {} as never,
      { read: jest.fn() } as never,
    );
    const tools = (adapter as any).deviceTools(scope) as Array<any>;
    const roomTool = tools.find(tool => tool.name === 'read_room_measurement');

    expect(roomTool).toBeDefined();
    expect(tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
      'list_devices', 'read_device_observation', 'read_room_measurement',
      'control_device', 'execute_approved_lighting_action',
    ]));
    const result = await roomTool.execute('call-1', { room: 'кухнята', metric: 'temperature' });
    expect(intelligence.readRoomMeasurement).toHaveBeenCalledWith(
      scope, 'кухнята', 'temperature',
    );
    expect(result.details).toEqual(measurement);
    expect(roomTool.parameters.properties.metric.enum).toEqual(['temperature', 'humidity']);
  });

  it('rejects invalid tool arguments without consulting Core', async () => {
    const intelligence = { readRoomMeasurement: jest.fn() };
    const adapter = new LettaHouseAgentAdapter(
      {} as never, {} as never, {} as never, intelligence as never, {} as never,
      { read: jest.fn() } as never,
    );
    const tool = (adapter as any).deviceTools({ tenantId: 'tenant-demo', siteId: 'site-home' })
      .find((item: any) => item.name === 'read_room_measurement');
    const result = await tool.execute('call-1', { room: 'Kitchen', metric: 'pressure' });
    expect(result.isError).toBe(true);
    expect(intelligence.readRoomMeasurement).not.toHaveBeenCalled();
  });

  it('exposes a read-only health tool and validates its bounded range before Core access', async () => {
    const scope = { tenantId: 'tenant-demo', siteId: 'site-home' };
    const health = { status: 'available', device: { name: 'Kitchen' }, history: { failureCount: 2 } };
    const deviceHealth = { read: jest.fn().mockResolvedValue(health) };
    const adapter = new LettaHouseAgentAdapter(
      {} as never, {} as never, {} as never, {} as never, {} as never, deviceHealth as never,
    );
    const tool = (adapter as any).deviceTools(scope).find((item: any) => item.name === 'read_device_health_history');
    expect(tool.parameters.properties.range.enum).toEqual(['1h', '24h', '7d', '30d']);
    const result = await tool.execute('call-health', { device: 'кухнята', range: '24h' });
    expect(deviceHealth.read).toHaveBeenCalledWith(scope, { device: 'кухнята', range: '24h' });
    expect(result.details).toEqual(health);

    const rejected = await tool.execute('call-health', { device: 'Kitchen', range: '365d' });
    expect(rejected.isError).toBe(true);
    expect(deviceHealth.read).toHaveBeenCalledTimes(1);
  });

  it('keeps follow-up turns in the same site conversation and exposes the requested range on each turn', async () => {
    const scope = { tenantId: 'tenant-demo', siteId: 'site-home' };
    const deviceHealth = { read: jest.fn().mockResolvedValue({ status: 'available' }) };
    const adapter = new LettaHouseAgentAdapter(
      {} as never, {} as never, {} as never, {} as never, {} as never, deviceHealth as never,
    );
    (adapter as any).agentFor = jest.fn().mockResolvedValue('agent-home');
    const sent: string[] = [];
    const fakeSession = {
      send: jest.fn(async (text: string) => { sent.push(text); }),
      stream: async function* () { yield { type: 'result', success: true, result: 'Evidence reviewed', conversationId: 'conversation-home' }; },
      close: jest.fn(),
    };
    const client = (adapter as any).client;
    client.resumeSession.mockReturnValue(fakeSession);

    await adapter.talk(scope, 'Енергрид, защо датчикът в кухнята прекъсва през последните 24 часа?');
    await adapter.talk(scope, 'А имал ли е проблеми с паметта през последните 7 дни?');

    expect(sent).toHaveLength(2);
    expect(client.resumeSession).toHaveBeenCalledTimes(2);
    expect(client.resumeSession.mock.calls.map((call: any[]) => call[0])).toEqual(['agent-home', 'agent-home']);
    const tools = client.resumeSession.mock.calls[1][1].tools as Array<any>;
    const tool = tools.find(item => item.name === 'read_device_health_history');
    await tool.execute('call-24h', { device: 'Kitchen', range: '24h' });
    await tool.execute('call-7d', { device: 'Kitchen', range: '7d' });
    expect(deviceHealth.read.mock.calls).toEqual([
      [scope, { device: 'Kitchen', range: '24h' }],
      [scope, { device: 'Kitchen', range: '7d' }],
    ]);
  });
});
