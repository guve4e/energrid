import { ShellyMqttAdapter } from './shelly-mqtt.adapter';

describe('Shelly electrical reading normalization', () => {
  const parse = (
    component: Record<string, unknown>,
    name = 'switch:0',
    ts: number | null = 1791676800,
  ) => {
    const adapter = new ShellyMqttAdapter();
    return adapter.handle({
      topic: 'shelly/meter/events/rpc',
      payloadText: '{}',
      payload: { src: 'shelly-meter', params: { ts, [name]: component } },
    })!;
  };
  const readings = (result: ReturnType<typeof parse>) =>
    (
      result.effects.find(effect => effect.kind === 'telemetry') as {
        payload: { readings: Array<Record<string, unknown>> };
      }
    ).payload.readings;
  it('normalizes watts and switch energy counters from Wh to kWh', () => {
    expect(
      readings(
        parse({
          apower: 3000,
          aenergy: { total: 12500 },
          ret_aenergy: { total: 500 },
        }),
      ),
    ).toEqual([
      expect.objectContaining({
        metric: 'power',
        value: 3000,
        unit: 'W',
        channel: 'switch:0',
      }),
      expect.objectContaining({
        metric: 'energy_import_total',
        value: 12.5,
        unit: 'kWh',
      }),
      expect.objectContaining({
        metric: 'energy_export_total',
        value: 0.5,
        unit: 'kWh',
      }),
    ]);
  });
  it('normalizes EM1Data to the same measurement channel as EM1', () => {
    expect(
      readings(
        parse(
          { total_act_energy: 5000, total_act_ret_energy: 1000 },
          'em1data:0',
        ),
      ),
    ).toEqual([
      expect.objectContaining({
        metric: 'energy_import_total',
        value: 5,
        channel: 'em1:0',
      }),
      expect.objectContaining({
        metric: 'energy_export_total',
        value: 1,
        channel: 'em1:0',
      }),
    ]);
  });
  it('preserves signed power and distinguishes device time from collector time', () => {
    expect(readings(parse({ act_power: -100 }, 'em1:0'))[0]).toEqual(
      expect.objectContaining({
        value: -100,
        timestampBasis: 'device-observed',
      }),
    );
    expect(
      readings(parse({ apower: 100 }, 'switch:0', null))[0].timestampBasis,
    ).toBe('collector-received');
  });
  it('keeps explicitly broken samples as invalid continuity breaks, not zero', () => {
    expect(readings(parse({ apower: null }))[0]).toEqual(
      expect.objectContaining({ value: null, quality: 'invalid' }),
    );
    expect(
      readings(parse({ total_act_energy: -1 }, 'em1data:0'))[0].value,
    ).toBeNull();
  });
  it('does not label fallback collector time as device time when a timestamp is malformed', () => {
    const adapter = new ShellyMqttAdapter();
    const result = adapter.handle({
      topic: 'shelly/meter/events/rpc',
      payloadText: '{}',
      payload: {
        src: 'shelly-meter',
        params: { ts: 'broken', 'em1:0': { act_power: 100 } },
      },
    })!;
    expect(readings(result)[0].timestampBasis).toBe('collector-received');
  });
  it('handles all supported channels in one notification', () => {
    const adapter = new ShellyMqttAdapter();
    const result = adapter.handle({
      topic: 'shelly/meter/events/rpc',
      payloadText: '{}',
      payload: {
        src: 'shelly-meter',
        params: {
          ts: 1791676800,
          'switch:0': { apower: 100 },
          'switch:1': { apower: 200 },
        },
      },
    })!;
    expect(result.effects.filter(effect => effect.kind === 'telemetry')).toHaveLength(2);
    expect(
      result.effects
        .filter(effect => effect.kind === 'telemetry')
        .map(effect => (effect.payload as { readings: Array<{ channel: string }> }).readings[0].channel),
    ).toEqual(['switch:0', 'switch:1']);
  });
  it('keeps component identity stable when the MQTT address prefix changes', () => {
    const adapter = new ShellyMqttAdapter();
    const message = (topic: string) => adapter.handle({
      topic,
      payloadText: '{}',
      payload: {
        src: 'shellyproem50-08f9e0e84910',
        params: { ts: 1791676800, 'em1:1': { act_power: 88.2 } },
      },
    })!;
    const before = message('shelly/boiler@oven/events/rpc');
    const after = message('custom/site-prefix/events/rpc');
    expect(before.physicalDiscoveries?.[0].identity).toEqual({
      namespace: 'mqtt:shelly-protocol-id', value: 'shellyproem50-08f9e0e84910',
    });
    expect(after.physicalDiscoveries?.[0].identity).toEqual(before.physicalDiscoveries?.[0].identity);
    expect((before.effects.find(effect => effect.kind === 'telemetry')?.payload as any).readings[0].channel).toBe('em1:1');
    expect((after.effects.find(effect => effect.kind === 'telemetry')?.payload as any).readings[0].channel).toBe('em1:1');
  });
  it('normalizes EM1Data to the EM1 component identity', () => {
    const result = new ShellyMqttAdapter().handle({
        topic: 'shelly/meter/status/em1data:0',
        payloadText: '{}',
        payload: { src: 'shelly-meter', total_act_energy: 100 },
      });
    expect(result?.effects.find(effect => effect.kind === 'telemetry')?.payload).toEqual(
      expect.objectContaining({
        target: expect.objectContaining({ componentKey: 'em1:0', channel: 0 }),
      }),
    );
  });
});

describe('ShellyMqttAdapter', () => {
  it('returns identity, component, telemetry, and discovery as data without a Registry', () => {
    const adapter = new ShellyMqttAdapter();
    const result = adapter.handle({
      topic: 'shellyplus2pm-001122334455/events/rpc',
      payloadText: '{"src":"shellyplus2pm-001122334455"}',
      payload: {
        src: 'shellyplus2pm-001122334455',
        params: { ts: 1791676800, 'switch:0': { output: true, apower: 42 } },
      },
    });

    expect(result?.effects).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'discovery' }),
      expect.objectContaining({ kind: 'telemetry' }),
    ]));
    expect(result?.effects.find(effect => effect.kind === 'telemetry')?.payload).toEqual(
      expect.objectContaining({
        target: {
          identity: { namespace: 'mqtt:shelly-protocol-id', value: 'shellyplus2pm-001122334455' },
          componentKey: 'switch:0',
          channel: 0,
        },
        values: { on: true, power: 42 },
      }),
    );
    expect(result?.physicalDiscoveries?.[0]).toEqual(expect.objectContaining({
      identity: { namespace: 'mqtt:shelly-protocol-id', value: 'shellyplus2pm-001122334455' },
      components: [{ key: 'switch:0', capabilities: ['power', 'switch'] }],
    }));
    expect(result?.physicalDiscoveries?.[0]).not.toHaveProperty('scope');
  });

  it('declares each Shelly component independently for a multi-component message', () => {
    const result = new ShellyMqttAdapter().handle({
      topic: 'shellypro3em-001122334455/events/rpc',
      payloadText: '{}',
      payload: {
        src: 'shellypro3em-001122334455',
        params: {
          'em1:0': { act_power: 125 },
          'em1:1': { act_power: 260 },
        },
      },
    });

    expect(result?.effects.filter(effect => effect.kind === 'telemetry')).toHaveLength(2);
    expect(result?.physicalDiscoveries?.map(item => item.components[0].key)).toEqual(['em1:0', 'em1:1']);
    expect(result?.physicalDiscoveries?.map(item => item.identity.value)).toEqual([
      'shellypro3em-001122334455', 'shellypro3em-001122334455',
    ]);
  });

  it('proposes one stable physical identity with independently keyed measurement components', () => {
    const adapter = new ShellyMqttAdapter();
    const first = adapter.handle({
      topic: 'shelly/boiler@oven/events/rpc',
      payloadText: '{}',
      payload: {
        src: 'shellypro3em-001122334455',
        params: {
          'em1:0': { act_power: 125 },
          'em1:1': { act_power: 260 },
        },
      },
    });
    const changedPrefix = adapter.handle({
      topic: 'new-prefix/changed/events/rpc',
      payloadText: '{}',
      payload: { src: 'shellypro3em-001122334455', params: { 'em1:0': { act_power: 130 } } },
    });

    expect(first?.physicalDiscoveries).toEqual([
      expect.objectContaining({
        identity: { namespace: 'mqtt:shelly-protocol-id', value: 'shellypro3em-001122334455' },
        components: [{ key: 'em1:0', capabilities: ['power'] }],
      }),
      expect.objectContaining({
        identity: { namespace: 'mqtt:shelly-protocol-id', value: 'shellypro3em-001122334455' },
        components: [{ key: 'em1:1', capabilities: ['power'] }],
      }),
    ]);
    expect(changedPrefix?.physicalDiscoveries?.[0].identity).toEqual(first?.physicalDiscoveries?.[0].identity);
    expect(changedPrefix?.physicalDiscoveries?.[0].endpoint?.address).toBe('new-prefix/changed/events/rpc');
    expect(first?.effects.filter(effect => effect.kind === 'discovery')).toHaveLength(2);
    expect(changedPrefix?.effects.filter(effect => effect.kind === 'discovery')).toHaveLength(1);
  });

  it('does not treat a custom MQTT prefix as a Shelly physical identity', () => {
    const adapter = new ShellyMqttAdapter();
    expect(adapter.handle({
      topic: 'shelly/boiler@oven/events/rpc',
      payloadText: '{}',
      payload: { params: { 'em1:0': { act_power: 125 } } },
    })).toBeNull();
  });

  it('subscribes to standard device-root notifications/status as well as the existing shared prefix', () => {
    const adapter = new ShellyMqttAdapter();
    expect(adapter.subscriptions()).toEqual([
      'shelly/#',
      '+/events/rpc',
      '+/status/+',
    ]);
    expect(adapter.subscriptions()).not.toContain('#');
  });

  it.each([
    [
      'shellyplus2pm-001122334455/events/rpc',
      {
        src: 'shellyplus2pm-001122334455',
        method: 'NotifyStatus',
        params: { 'switch:0': { output: true, apower: 100 } },
      },
    ],
    [
      'shellyplus2pm-001122334455/status/switch:0',
      { id: 0, output: true, apower: 100 },
    ],
  ])(
    'returns declarative discovery without approving or controlling an unknown publisher: %s',
    (topic, payload) => {
      const adapter = new ShellyMqttAdapter();
      const result = adapter.handle({
        topic,
        payload,
        payloadText: JSON.stringify(payload),
      });
      expect(result?.physicalDiscoveries).toEqual(expect.any(Array));
      expect(result?.effects.find(effect => effect.kind === 'discovery')?.payload)
        .toEqual(expect.objectContaining({
          id: expect.stringContaining('shellyplus2pm-001122334455'),
          driver: 'shelly-discovered',
        }));
      expect(result?.effects.find(effect => effect.kind === 'telemetry')?.payload)
        .not.toHaveProperty('deviceId');
    },
  );
  it('discovers channels from the existing full-status publisher without approval or control', () => {
    const adapter = new ShellyMqttAdapter();
    const physicalId = 'shellyplus2pm-001122334455';
    const result = adapter.handle({
        topic: `shelly/status/${physicalId}`,
        payloadText: '{}',
        payload: {
          id: physicalId,
          'switch:0': { output: false, apower: 0 },
          'switch:1': { output: true, apower: 100 },
          'input:0': { state: false },
        },
      });
    expect(result?.effects.filter(effect => effect.kind === 'discovery').map(effect => (effect.payload as any).id))
      .toEqual([`${physicalId}:switch:0`, `${physicalId}:switch:1`]);
    expect(result?.physicalDiscoveries?.flatMap(discovery => discovery.components.map(component => component.key)))
      .toEqual(['switch:0', 'switch:1']);
  });

  it('normalizes full-status readings as an unresolved telemetry candidate', () => {
    const adapter = new ShellyMqttAdapter();
    const physicalId = 'shellyplus2pm-78ee4ccf5cf0';
    expect(
      adapter.handle({
        topic: `shelly/status/${physicalId}`,
        payloadText: '{}',
        payload: {
          id: physicalId,
          'switch:0': { output: true, apower: 100 },
        },
      })?.effects,
    ).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'telemetry',
        payload: expect.objectContaining({
          target: expect.objectContaining({
            identity: { namespace: 'mqtt:shelly-protocol-id', value: physicalId },
            componentKey: 'switch:0',
          }),
          readings: [
            expect.objectContaining({
              channel: 'switch:0',
              metric: 'power',
              value: 100,
              timestampBasis: 'collector-received',
            }),
          ],
        }),
      }),
    ]));
  });

  it.each([{ id: 'different-device' }, { src: 'different-device' }])(
    'rejects a full-status snapshot with conflicting identity: %j',
    (identity) => {
      const adapter = new ShellyMqttAdapter();
      expect(
        adapter.handle({
          topic: 'shelly/status/shellyplus2pm-001122334455',
          payloadText: '{}',
          payload: { ...identity, 'switch:0': { output: true } },
        }),
      ).toBeNull();
    },
  );

  it('does not interpret arbitrary top-level component objects as Shelly snapshots', () => {
    const adapter = new ShellyMqttAdapter();
    expect(
      adapter.handle({
        topic: 'unrelated/status/device',
        payloadText: '{}',
        payload: { id: 'device', 'switch:0': { output: true } },
      }),
    ).toBeNull();
  });

  it.each([false, true])(
    'discovers one meter channel for EM1 and its energy counters, counters first: %s',
    (countersFirst) => {
      const adapter = new ShellyMqttAdapter();
      const physicalId = 'shellyproem50-001122334455';
      const components = [
        ['em1:0', { act_power: 100 }],
        ['em1data:0', { total_act_energy: 200 }],
      ] as const;
      for (const [name, component] of countersFirst
        ? [...components].reverse()
        : components) {
        expect(
          adapter.handle({
            topic: `${physicalId}/status/${name}`,
            payloadText: '{}',
            payload: component,
          })?.effects,
        ).toEqual(expect.arrayContaining([
          expect.objectContaining({ kind: 'discovery', payload: expect.objectContaining({ id: `${physicalId}:em1:0` }) }),
          expect.objectContaining({ kind: 'telemetry', payload: expect.objectContaining({ target: expect.objectContaining({ componentKey: 'em1:0' }) }) }),
        ]));
      }
    },
  );

  it('normalizes Shelly NotifyStatus without requiring a specific topic root', () => {
    const adapter = new ShellyMqttAdapter();

    const result = adapter.handle({
      topic: 'custom/site/events/rpc',
      payloadText: JSON.stringify({
        src: 'shellyplus2pm-78ee4ccf5cf0',
        params: {
          ts: 1786012000,
          'switch:0': {
            id: 0,
            output: true,
            apower: 11.8,
            current: 0.05,
            voltage: 231.2,
          },
        },
      }),
      payload: {
        src: 'shellyplus2pm-78ee4ccf5cf0',
        params: {
          ts: 1786012000,
          'switch:0': {
            id: 0,
            output: true,
            apower: 11.8,
            current: 0.05,
            voltage: 231.2,
          },
        },
      },
    });

    expect(result).toEqual(
      expect.objectContaining({
        reason: 'shelly telemetry',
        effects: expect.arrayContaining([
          expect.objectContaining({
            kind: 'telemetry',
            payload: expect.objectContaining({
              target: expect.objectContaining({
                identity: { namespace: 'mqtt:shelly-protocol-id', value: 'shellyplus2pm-78ee4ccf5cf0' },
                componentKey: 'switch:0',
              }),
              origin: 'shelly-mqtt',
              status: 'online',
              values: {
                on: true,
                power: 11.8,
                current: 0.05,
                voltage: 231.2,
              },
            }),
          }),
        ]),
      }),
    );
  });

  it('returns telemetry as a candidate without claiming approval', () => {
    const adapter = new ShellyMqttAdapter();

    const result = adapter.handle({
      topic: 'shelly/events/rpc',
      payloadText: '{}',
      payload: {
        src: 'shellyplus2pm-UNAPPROVED',
        params: {
          'switch:1': {
            id: 1,
            output: true,
          },
        },
      },
    });

    expect(result?.effects.find(effect => effect.kind === 'telemetry')?.payload)
      .toEqual(expect.objectContaining({
        target: expect.objectContaining({ componentKey: 'switch:1' }),
      }));
  });

  it('returns null for unrelated JSON messages', () => {
    const adapter = new ShellyMqttAdapter();

    expect(
      adapter.handle({
        topic: 'energrid/valentin/boyana-home/debug/manual',
        payloadText: '{"hello":"world"}',
        payload: {
          hello: 'world',
        },
      }),
    ).toBeNull();
  });
});
