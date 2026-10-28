import type { FactoryProvider } from '@nestjs/common';
import { OperationalLogService } from '../operational-log.service';
import { DeviceExecutionInvestigator } from '../investigation/device-execution-investigator';
import { DEVICE_COMMAND_TRACKER, type CommandEventSink, type DeviceCommandTracker } from './device-command-tracker';
import { InMemoryDeviceCommandTracker } from './in-memory-device-command-tracker';

export function createDeviceCommandTracker(log?: CommandEventSink): DeviceCommandTracker {
  const configuredNumber = (name: string, fallback: number) => {
    const value = Number(process.env[name]);
    return Number.isFinite(value) ? value : fallback;
  };
  return new InMemoryDeviceCommandTracker(
    { now: () => Date.now() },
    {
      ackTimeoutMs: () => configuredNumber('HOME_DEVICE_ACK_TIMEOUT_MS', 5000),
      settleWindowMs: () => configuredNumber('HOME_DEVICE_SETTLE_WINDOW_MS', 2000),
      traceLimit: () => configuredNumber('HOME_DEVICE_EXECUTION_TRACE_LIMIT', 200),
    },
    new DeviceExecutionInvestigator(),
    log,
  );
}

export const deviceCommandTrackerProvider: FactoryProvider<DeviceCommandTracker> = {
  provide: DEVICE_COMMAND_TRACKER,
  inject: [OperationalLogService],
  useFactory: createDeviceCommandTracker,
};
