import { DeviceExecutionInvestigator } from './device-execution-investigator';

describe('DeviceExecutionInvestigator', () => {
  const investigator = new DeviceExecutionInvestigator();

  it('classifies settled executions as successful', () => {
    const diagnosis = investigator.investigate({
      outcome: 'settled',
      deviceId: 'kitchen.light',
    } as any);

    expect(diagnosis.category).toBe('success');
    expect(diagnosis.stage).toBe('settling');
    expect(diagnosis.confidence).toBe(1);
  });

  it('classifies timeout executions', () => {
    const diagnosis = investigator.investigate({
      outcome: 'timed_out',
      deviceId: 'kitchen.light',
    } as any);

    expect(diagnosis.category).toBe('ack_missing');
    expect(diagnosis.stage).toBe('telemetry');
    expect(diagnosis.recommendations.length).toBeGreaterThan(0);
  });

  it('falls back to unknown', () => {
    const diagnosis = investigator.investigate({
      outcome: 'banana',
      deviceId: 'kitchen.light',
    } as any);

    expect(diagnosis.category).toBe('unknown');
  });
});
