import { DeviceRegistryService } from '../device-registry.service';
import { OperationalLogService } from '../operational-log.service';
import { createDeviceCommandTracker } from '../commands/device-command-tracker.provider';

export function createDeviceRegistry(log?: OperationalLogService): DeviceRegistryService {
  return new DeviceRegistryService(log, undefined, undefined, createDeviceCommandTracker(log));
}
