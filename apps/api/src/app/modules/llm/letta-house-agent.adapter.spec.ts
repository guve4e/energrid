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
    );
    const tool = (adapter as any).deviceTools({ tenantId: 'tenant-demo', siteId: 'site-home' })
      .find((item: any) => item.name === 'read_room_measurement');
    const result = await tool.execute('call-1', { room: 'Kitchen', metric: 'pressure' });
    expect(result.isError).toBe(true);
    expect(intelligence.readRoomMeasurement).not.toHaveBeenCalled();
  });
});
