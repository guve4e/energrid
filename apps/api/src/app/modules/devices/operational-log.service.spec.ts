import { OperationalLogService } from './operational-log.service';

describe('OperationalLogService MQTT retention', () => {
  afterEach(() => {
    delete process.env.HOME_OPERATION_LOG_MAX_ENTRIES;
  });

  it('ignores broker $SYS chatter in device-processing diagnostics', () => {
    const logs = new OperationalLogService();

    expect(logs.recordMqttStage({
      correlationId: 'sys-1', topic: '$SYS/broker/uptime', stage: 'received', outcome: 'received',
    })).toBeNull();
    expect(logs.recent()).toEqual([]);
  });

  it('bounds repeated unrelated topics so they cannot evict another device trace', () => {
    process.env.HOME_OPERATION_LOG_MAX_ENTRIES = '40';
    const logs = new OperationalLogService();
    logs.recordMqttStage({
      correlationId: 'kitchen', topic: 'devices/temp-kitchen/data', stage: 'received', outcome: 'received',
    });

    for (let index = 0; index < 200; index += 1) {
      logs.recordMqttStage({
        correlationId: `other-${index}`, topic: 'shelly/washer/status', stage: 'received', outcome: 'received',
      });
    }

    expect(logs.recent(40).some(entry => entry.correlationId === 'kitchen')).toBe(true);
    expect(logs.recent(40).filter(entry => entry.topic === 'shelly/washer/status')).toHaveLength(32);
  });
});
