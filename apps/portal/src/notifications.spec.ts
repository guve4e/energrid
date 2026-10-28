import { describe, expect, it } from 'vitest';
import {
  deviceHealthNotifications,
  failedActionNotification,
  mergeNotifications,
} from './notifications';

describe('dashboard notifications', () => {
  it('notifies only on observed health transitions, not initial stale state', () => {
    const stale = [{ deviceId: 'relay-1', status: 'stale' as const, reason: 'No recent telemetry', lastSeen: '2026-10-17T10:00:00Z' }];
    expect(deviceHealthNotifications([], stale, { 'relay-1': 'Kitchen light' })).toEqual([]);
    expect(deviceHealthNotifications(
      [{ ...stale[0], status: 'healthy' }], stale, { 'relay-1': 'Kitchen light' }, new Date('2026-10-17T10:01:00Z'),
    )).toMatchObject([{
      severity: 'critical',
      title: 'Device not reporting',
      message: 'Kitchen light: No recent telemetry.',
    }]);
  });

  it('announces recovery and deduplicates persisted notifications', () => {
    const recovery = deviceHealthNotifications(
      [{ deviceId: 'relay-1', status: 'stale', reason: 'Delayed', lastSeen: 'old' }],
      [{ deviceId: 'relay-1', status: 'healthy', reason: 'Fresh', lastSeen: 'new' }],
      { 'relay-1': 'Kitchen light' }, new Date('2026-10-17T10:02:00Z'),
    );
    expect(recovery[0].message).toBe('Kitchen light is reporting again.');
    expect(mergeNotifications(recovery, recovery)).toEqual(recovery);
  });

  it('creates actionable failed-command details', () => {
    expect(failedActionNotification('relay-1', 'Kitchen light', 'turn_off', 'No acknowledgement', new Date('2026-10-17T10:03:00Z'))).toMatchObject({
      severity: 'critical',
      title: 'Device command failed',
      message: 'Kitchen light: turn off failed. No acknowledgement',
    });
  });
});
