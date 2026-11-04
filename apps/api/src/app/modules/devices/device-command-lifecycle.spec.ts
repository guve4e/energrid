import { createDeviceRegistry } from './testing/device-registry.fixture';
import { DeviceRegistryService } from './device-registry.service';
import { OperationalLogService } from './operational-log.service';

// Characterization tests exercise the public registry boundary before and after extraction.
describe('device command lifecycle through the registry', () => {
  const originalEnv = process.env;
  const start = Date.parse('2026-01-01T00:00:00Z');
  let registry: DeviceRegistryService;
  let log: OperationalLogService;
  const deviceId = 'kitchen_light';
  const pending = (on = true, ttlMs?: number) => registry.markDeviceCommandPending(deviceId, {
    action: on ? 'turn_on' : 'turn_off', expectedValues: { on }, ttlMs,
  });
  const current = () => registry.getDevices().find(d => d.id === deviceId)?.state.command;
  const observe = (on: boolean, commandId?: string, observedAt = new Date().toISOString()) =>
    registry.ingestDeviceTelemetry({ deviceId, values: { on }, observedAt, evidence: { commandId } });

  beforeEach(() => {
    process.env = { HOME_DEVICE_ACK_TIMEOUT_MS: '5000', HOME_DEVICE_SETTLE_WINDOW_MS: '2000', HOME_DEVICE_EXECUTION_TRACE_LIMIT: '200' };
    jest.useFakeTimers().setSystemTime(start);
    log = new OperationalLogService();
    registry = createDeviceRegistry(log);
  });
  afterEach(() => { jest.useRealTimers(); process.env = originalEnv; });

  it('publication alone remains pending and does not claim device receipt', () => {
    const command = pending();
    registry.markDeviceCommandPublished(deviceId, command.id, { topic: 'home/switch' });
    expect(current()?.status).toBe('pending');
    const trace = registry.getLatestExecutionTrace(deviceId)!;
    expect(trace.outcome).toBe('running');
    expect(trace.stages.map(s => s.stage)).toEqual(['requested', 'published']);
    expect(trace).not.toHaveProperty('expiresAt');
    expect(current()).not.toHaveProperty('displayUntil');
  });

  it('preserves the requesting actor in command evidence without exposing mutable state', () => {
    const actor = { type: 'user' as const, id: 'operator-42', name: 'Operator' };
    const command = registry.markDeviceCommandPending(deviceId, {
      action: 'turn_on', expectedValues: { on: true }, actor,
    });
    const trace = registry.getLatestExecutionTrace(deviceId)!;
    expect(trace.commandId).toBe(command.id);
    expect(trace.actor).toEqual(actor);

    actor.name = 'Changed by caller';
    trace.actor.name = 'Changed by viewer';
    expect(registry.getLatestExecutionTrace(deviceId)?.actor).toEqual({
      type: 'user', id: 'operator-42', name: 'Operator',
    });
  });

  it('keeps the system fallback when no caller identity was supplied', () => {
    pending();
    expect(registry.getLatestExecutionTrace(deviceId)?.actor).toEqual({
      type: 'system', name: 'Energrid Control Service',
    });
  });

  it('rejects stale observations and evidence for a different command', () => {
    const command = pending();
    observe(true, command.id, new Date(start - 1).toISOString());
    expect(current()?.status).toBe('pending');
    expect(registry.getLatestExecutionTrace(deviceId)?.stages.some(s => s.stage === 'stale')).toBe(true);
    observe(true, 'another-command');
    expect(current()?.status).toBe('pending');
    observe(true, command.id);
    expect(current()?.status).toBe('acked');
  });

  it('records correlated mismatches without acknowledging the command', () => {
    const command = pending();
    observe(false, command.id);
    expect(current()?.status).toBe('pending');
    expect(registry.getLatestExecutionTrace(deviceId)?.stages.at(-1)?.stage).toBe('mismatched');
  });

  it('accepts matching uncorrelated telemetry, settles, and expires the display independently', () => {
    pending();
    observe(true);
    expect(current()?.status).toBe('acked');
    jest.setSystemTime(start + 1999);
    expect(registry.getLatestExecutionTrace(deviceId)?.outcome).toBe('running');
    jest.setSystemTime(start + 2000);
    expect(registry.getLatestExecutionTrace(deviceId)).toMatchObject({ outcome: 'settled', durationMs: 2000, diagnosis: { category: 'success' } });
    jest.setSystemTime(start + 5001);
    expect(current()).toBeUndefined();
    expect(registry.getLatestExecutionTrace(deviceId)?.outcome).toBe('settled');
  });

  it('marks contradictory telemetry during settling as drift', () => {
    pending(); observe(true);
    jest.setSystemTime(start + 1000); observe(false);
    expect(registry.getLatestExecutionTrace(deviceId)).toMatchObject({ outcome: 'drifted', diagnosis: { category: 'verification_failed' } });
  });

  it('times out only after the deadline and logs the transition once', () => {
    pending(true, 1000);
    jest.setSystemTime(start + 1000);
    expect(current()?.status).toBe('pending');
    jest.setSystemTime(start + 1001);
    expect(current()?.status).toBe('no_ack');
    expect(current()?.status).toBe('no_ack');
    expect(registry.getLatestExecutionTrace(deviceId)).toMatchObject({ outcome: 'timed_out', durationMs: 1000, diagnosis: { category: 'ack_missing' } });
    expect(log.recent().filter(e => e.event === 'command.no_ack')).toHaveLength(1);
    jest.setSystemTime(start + 31002);
    expect(current()).toBeUndefined();
  });

  it('does not revive an expired command with late telemetry', () => {
    const command = pending();
    jest.setSystemTime(start + 5001); observe(true, command.id);
    expect(current()?.status).toBe('no_ack');
    expect(registry.getLatestExecutionTrace(deviceId)?.outcome).toBe('timed_out');
  });

  it('supersedes the earlier execution and ignores its correlated observation', () => {
    const first = pending();
    jest.setSystemTime(start + 1);
    const second = pending(false);
    observe(true, first.id);
    expect(current()).toMatchObject({ id: second.id, status: 'pending' });
    expect(registry.getExecutionTraces().find(t => t.id === first.id)?.outcome).toBe('superseded');
    observe(false, second.id);
    expect(current()?.status).toBe('acked');
  });

  it('keeps transport failure diagnosis and failed display state', () => {
    const command = pending();
    registry.markDeviceCommandTransportFailed(deviceId, command.id, 'transport unavailable');
    expect(current()).toMatchObject({ id: command.id, status: 'failed', requestedAt: command.requestedAt });
    expect(registry.getLatestExecutionTrace(deviceId)?.commandId).toBe(command.id);
    expect(registry.getLatestExecutionTrace(deviceId)).toMatchObject({ outcome: 'failed', diagnosis: { category: 'transport_failure' } });
    jest.setSystemTime(start + 30001);
    expect(current()).toBeUndefined();
  });

  it('preserves command ID when the authorized write fails before dispatch', () => {
    const command = pending();
    const failed = registry.markDeviceCommandFailed(deviceId, command.id, 'pre_write', 'identity check failed');
    expect(failed).toMatchObject({ id: command.id, status: 'failed', requestedAt: command.requestedAt });
    expect(registry.getLatestExecutionTrace(deviceId)).toMatchObject({
      commandId: command.id, outcome: 'failed', diagnosis: { category: 'unknown', stage: 'command' },
    });
    expect(registry.getLatestExecutionTrace(deviceId)?.stages.at(-1)?.stage).toBe('pre_write_failed');
    expect(log.recent().filter(e => e.event === 'command.failed')).toHaveLength(1);
  });

  it('classifies a mismatched fresh readback as verification failure, not transport failure', () => {
    const command = pending();
    registry.markDeviceCommandPublished(deviceId, command.id);
    const failed = registry.markDeviceCommandFailed(deviceId, command.id, 'readback_mismatch', 'readback OFF');
    expect(failed?.id).toBe(command.id);
    expect(registry.getLatestExecutionTrace(deviceId)).toMatchObject({
      commandId: command.id, outcome: 'failed', diagnosis: { category: 'verification_failed', stage: 'verification' },
    });
    expect(registry.getLatestExecutionTrace(deviceId)?.stages.at(-1)?.stage).toBe('mismatched');
  });

  it('assigns unique command IDs when consecutive requests share the same millisecond', () => {
    const first = pending();
    const second = pending(false);
    expect(second.id).not.toBe(first.id);
    expect(current()).toMatchObject({ id: second.id, status: 'pending' });
    expect(registry.getExecutionTraces().find(t => t.commandId === first.id)?.outcome).toBe('superseded');
  });

  it('does not let a late failure from a superseded command overwrite the current command', () => {
    const first = pending();
    jest.setSystemTime(start + 1);
    const second = pending(false);
    expect(registry.markDeviceCommandFailed(deviceId, first.id, 'pre_write', 'late error')).toBeNull();
    registry.markDeviceCommandTransportFailed(deviceId, first.id, 'late network error');
    expect(current()).toMatchObject({ id: second.id, status: 'pending' });
    const oldTrace = registry.getExecutionTraces().find(t => t.commandId === first.id);
    expect(oldTrace?.outcome).toBe('superseded');
    expect(oldTrace?.stages.some(s => s.stage === 'transport_failed')).toBe(false);
    expect(log.recent().filter(e => e.event === 'command.failed')).toHaveLength(0);
  });

  it('rejects a failure for the wrong device and cannot fail an already acknowledged command', () => {
    const command = pending();
    expect(registry.markDeviceCommandFailed('other', command.id, 'pre_write', 'wrong device')).toBeNull();
    observe(true, command.id);
    expect(registry.markDeviceCommandFailed(deviceId, command.id, 'pre_write', 'late error')).toBeNull();
    registry.markDeviceCommandTransportFailed(deviceId, command.id, 'late error');
    expect(current()).toMatchObject({ id: command.id, status: 'acked' });
    expect(registry.getLatestExecutionTrace(deviceId)?.outcome).toBe('running');
  });

  it('ignores publication evidence for unknown commands or another device', () => {
    const command = pending();
    expect(registry.markDeviceCommandPublished(deviceId, 'missing')).toBeNull();
    expect(registry.markDeviceCommandPublished('other', command.id)).toBeNull();
    expect(registry.markDeviceCommandTransportFailed('other', command.id, 'error')).toBeNull();
    expect(registry.getLatestExecutionTrace(deviceId)?.stages).toHaveLength(1);
  });

  it('retains only the configured number of newest traces', () => {
    process.env.HOME_DEVICE_EXECUTION_TRACE_LIMIT = '2';
    const first = pending();
    jest.setSystemTime(start + 1); const second = pending(false);
    jest.setSystemTime(start + 2); const third = pending();
    expect(registry.getExecutionTraces().map(t => t.id)).toEqual([third.id, second.id]);
    expect(registry.getExecutionTraces().some(t => t.id === first.id)).toBe(false);
    expect(registry.getExecutionTraces(1)).toHaveLength(1);
  });
});
