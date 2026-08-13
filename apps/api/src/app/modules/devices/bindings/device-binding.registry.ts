import { Injectable } from '@nestjs/common';
import type { ShellyRpcDeviceConfig } from '../device-registry.types';

@Injectable()
export class DeviceBindingRegistry {
  getShellyBindings(): ShellyRpcDeviceConfig[] {
    return [
      {
        key: 'kitchen-shelly',
        dst: 'kitchen-shelly',
        switchId: 0,
      },
    ];
  }
}
