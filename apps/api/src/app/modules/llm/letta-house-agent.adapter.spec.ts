jest.mock('@letta-ai/letta-agent-sdk', () => ({
  LettaAgentClient: class {
    createAgent = jest.fn();
    resumeSession = jest.fn();
  },
}));

import { houseAgentScopeKey, LettaHouseAgentAdapter } from './letta-house-agent.adapter';

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
      readMeasurementSummary: jest.fn().mockResolvedValue({
        status: 'available', current: { status: 'fresh', value: 1483.3, unit: 'W' },
        history: { energyEstimate: { status: 'partial_estimate', signedEnergyKwh: 0.31, coveredDurationSeconds: 3500 } },
      }),
    };
    const adapter = new LettaHouseAgentAdapter(
      {} as never, {} as never, {} as never, intelligence as never, {} as never,
      { read: jest.fn() } as never,
      { tools: jest.fn().mockReturnValue([]) } as never,
      { tools: jest.fn().mockReturnValue([]) } as never,
    );
    const tools = (adapter as any).deviceTools(scope) as Array<any>;
    const roomTool = tools.find(tool => tool.name === 'read_room_measurement');

    expect(roomTool).toBeDefined();
    expect(tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
      'list_devices', 'read_device_observation', 'read_room_measurement',
      'read_device_measurement_history',
      'control_device', 'execute_approved_lighting_action',
    ]));
    const result = await roomTool.execute('call-1', { room: 'кухнята', metric: 'temperature' });
    expect(intelligence.readRoomMeasurement).toHaveBeenCalledWith(
      scope, 'кухнята', 'temperature',
    );
    expect(result.details).toEqual(measurement);
    expect(roomTool.parameters.properties.metric.enum).toEqual(['temperature', 'humidity']);

    const historyTool = tools.find(tool => tool.name === 'read_device_measurement_history');
    expect(historyTool.parameters.properties.range.enum).toEqual(['1h', '24h', '7d']);
    expect(historyTool.description).toContain('signed trapezoidal energy estimate');
    const historyResult = await historyTool.execute('call-history', {
      device: 'House Mainline', metric: 'power', range: '24h',
    });
    expect(intelligence.readMeasurementSummary).toHaveBeenCalledWith(
      scope, 'House Mainline', 'power', '24h',
    );
    expect(historyResult.details).toMatchObject({
      current: { status: 'fresh', value: 1483.3, unit: 'W' },
      history: { energyEstimate: { status: 'partial_estimate', signedEnergyKwh: 0.31 } },
    });
    await expect(historyTool.execute('call-history', { device: 'House Mainline', metric: 'power', range: '30d' }))
      .resolves.toMatchObject({ isError: true });
    expect(intelligence.readMeasurementSummary).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid tool arguments without consulting Core', async () => {
    const intelligence = { readRoomMeasurement: jest.fn() };
    const adapter = new LettaHouseAgentAdapter(
      {} as never, {} as never, {} as never, intelligence as never, {} as never,
      { read: jest.fn() } as never,
      { tools: jest.fn().mockReturnValue([]) } as never,
      { tools: jest.fn().mockReturnValue([]) } as never,
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
      { tools: jest.fn().mockReturnValue([]) } as never,
      { tools: jest.fn().mockReturnValue([]) } as never,
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

  it('registers scoped read-only weather tools in the same strict assistant session', async () => {
    const weatherTool = {
      name: 'weather_get_forecast', execute: jest.fn().mockResolvedValue({ details: { status: 'stale' } }),
    };
    const weatherTools = { tools: jest.fn().mockReturnValue([weatherTool]) };
    const adapter = new LettaHouseAgentAdapter(
      {} as never, {} as never, {} as never, {} as never, {} as never,
      { read: jest.fn() } as never,
      { tools: jest.fn().mockReturnValue([]) } as never,
      weatherTools as never,
    );
    (adapter as any).agentFor = jest.fn().mockResolvedValue('agent-weather');
    const client = (adapter as any).client;
    client.resumeSession.mockReturnValue({
      send: jest.fn(), close: jest.fn(),
      stream: async function* () { yield { type: 'result', success: true, result: 'Нямам актуални данни.', conversationId: 'weather-conversation' }; },
    });
    const scope = { tenantId: 'tenant-a', siteId: 'site-a' };
    await adapter.talk(scope, 'Енергрид, ще вали ли утре?');
    const options = client.resumeSession.mock.calls[0][1];
    expect(weatherTools.tools).toHaveBeenCalledWith(scope);
    expect(options.allowedTools).toContain('weather_get_forecast');
    expect(options.tools.map((tool: any) => tool.name)).toContain('weather_get_forecast');
    await expect(options.canUseTool('weather_get_forecast')).resolves.toMatchObject({ behavior: 'allow' });
    await expect(options.canUseTool('unknown_weather_write')).resolves.toMatchObject({ behavior: 'deny' });
    expect(options.permissionMode).toBe('strict');
  });

  it('keeps follow-up turns in the same site conversation and exposes the requested range on each turn', async () => {
    const scope = { tenantId: 'tenant-demo', siteId: 'site-home' };
    const deviceHealth = { read: jest.fn().mockResolvedValue({ status: 'available' }) };
    const adapter = new LettaHouseAgentAdapter(
      {} as never, {} as never, {} as never, {} as never, {} as never, deviceHealth as never,
      { tools: jest.fn().mockReturnValue([]) } as never,
      { tools: jest.fn().mockReturnValue([]) } as never,
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

  it('isolates authenticated Letta conversations by account and shares the finance tool boundary across turns', async () => {
    const principal = { userId: 'account-a', email: 'a@example.test', name: 'A', role: 'admin' as const, sessionId: 'session-a', sessionVersion: 1 };
    const financeTool = { name: 'finance.query_expenses', execute: jest.fn() };
    const financeTools = { tools: jest.fn().mockReturnValue([financeTool]) };
    const adapter = new LettaHouseAgentAdapter(
      {} as never, {} as never, {} as never, {} as never, {} as never,
      { read: jest.fn() } as never, financeTools as never,
      { tools: jest.fn().mockReturnValue([]) } as never,
    );
    (adapter as any).agentFor = jest.fn().mockResolvedValue('agent-account-a');
    const client = (adapter as any).client;
    const fakeSession = {
      send: jest.fn(),
      stream: async function* () { yield { type: 'result', success: true, result: 'Finance data', conversationId: 'conv-letta-a' }; },
      close: jest.fn(),
    };
    client.resumeSession.mockReturnValue(fakeSession);
    const scope = { tenantId: 'tenant-a', siteId: 'site-a', principal };
    const first = await adapter.talk(scope, 'How much did I spend?');
    expect(first.conversationId).not.toBe('conv-letta-a');
    expect(financeTools.tools).toHaveBeenCalledWith(expect.objectContaining({
      principal, conversationId: first.conversationId, userMessage: 'How much did I spend?',
    }));
    const options = client.resumeSession.mock.calls[0][1];
    expect(options.allowedTools).toContain('finance_query_expenses');
    expect(options.tools.map((tool: any) => tool.name)).toContain('finance_query_expenses');
    expect(financeTool.name).toBe('finance.query_expenses');
    await expect(options.canUseTool('finance_query_expenses')).resolves.toMatchObject({ behavior: 'allow' });
    await expect(options.canUseTool('read_room_measurement')).resolves.toMatchObject({ behavior: 'allow' });
    await expect(options.canUseTool('read_device_measurement_history')).resolves.toMatchObject({ behavior: 'allow' });

    await adapter.talk({ ...scope, conversationId: first.conversationId }, 'And October?');
    expect(client.resumeSession.mock.calls[1][0]).toBe('conv-letta-a');
    expect(financeTools.tools.mock.calls[1][0].conversationId).toBe(first.conversationId);
    expect(houseAgentScopeKey(scope)).not.toBe(houseAgentScopeKey({
      ...scope, principal: { ...principal, userId: 'account-b' },
    }));
  });

  it('starts a fresh account-bound conversation when a prior conversation handle has expired', async () => {
    const principal = { userId: 'account-a', email: 'a@example.test', name: 'A', role: 'admin' as const, sessionId: 'session-a', sessionVersion: 1 };
    const financeTools = { tools: jest.fn().mockReturnValue([]) };
    const adapter = new LettaHouseAgentAdapter(
      {} as never, {} as never, {} as never, {} as never, {} as never,
      { read: jest.fn() } as never, financeTools as never,
      { tools: jest.fn().mockReturnValue([]) } as never,
    );
    (adapter as any).agentFor = jest.fn().mockResolvedValue('agent-account-a');
    (adapter as any).conversations.set('expired-handle', {
      accountId: principal.userId, agentId: 'agent-account-a',
      lettaConversationId: 'old-letta-conversation', expiresAt: Date.now() - 1,
    });
    const fakeSession = {
      send: jest.fn(), close: jest.fn(),
      stream: async function* () { yield { type: 'result', success: true, result: 'Fresh conversation', conversationId: 'new-letta-conversation' }; },
    };
    const client = (adapter as any).client;
    client.resumeSession.mockReturnValue(fakeSession);

    const reply = await adapter.talk({
      tenantId: 'tenant-a', siteId: 'site-a', principal, conversationId: 'expired-handle',
    }, 'Yes.');

    expect(client.resumeSession).toHaveBeenCalledWith('agent-account-a', expect.any(Object));
    expect(reply.conversationId).not.toBe('expired-handle');
    expect(financeTools.tools).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: reply.conversationId, userMessage: 'Yes.',
    }));
  });

  it('resumes the same local default conversation by its agent id', async () => {
    const principal = { userId: 'account-a', email: 'a@example.test', name: 'A', role: 'admin' as const, sessionId: 'session-a', sessionVersion: 1 };
    const adapter = new LettaHouseAgentAdapter(
      {} as never, {} as never, {} as never, {} as never, {} as never,
      { read: jest.fn() } as never,
      { tools: jest.fn().mockReturnValue([]) } as never,
      { tools: jest.fn().mockReturnValue([]) } as never,
    );
    (adapter as any).agentFor = jest.fn().mockResolvedValue('agent-local-account-a');
    const client = (adapter as any).client;
    const fakeSession = {
      send: jest.fn(),
      close: jest.fn(),
      stream: async function* () {
        yield { type: 'result', success: true, result: 'Draft proposed', conversationId: 'default' };
      },
    };
    client.resumeSession.mockReturnValue(fakeSession);
    const scope = { tenantId: 'tenant-a', siteId: 'site-a', principal };

    const proposal = await adapter.talk(scope, 'Похарчих 76 евро в Лидл.');
    const confirmation = await adapter.talk(
      { ...scope, conversationId: proposal.conversationId },
      'Да, запиши го.',
    );

    expect(confirmation.conversationId).toBe(proposal.conversationId);
    expect(client.resumeSession.mock.calls.map((call: any[]) => call[0])).toEqual([
      'agent-local-account-a',
      'agent-local-account-a',
    ]);
  });
});
