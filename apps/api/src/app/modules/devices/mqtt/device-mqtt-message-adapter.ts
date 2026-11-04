import type { PhysicalDeviceDiscovery } from '../enrollment/physical-device-inventory.repository';

export interface DeviceMqttObservationAdmission {
  deviceId?: string;
  outcome: 'admitted' | 'rejected';
  reasonCode?: string;
}

export interface DeviceMqttMessage {
  topic: string;
  payload: unknown;
  payloadText: string;
}

export type DeviceMqttEffect =
  | {
      kind: 'discovery';
      payload: unknown;
    }
  | {
      kind: 'registry';
      payload: unknown;
    }
  | {
      kind: 'telemetry';
      payload: unknown;
    }
  | {
      kind: 'status';
      payload: unknown;
    };

export interface DeviceMqttAdapterResult {
  reason: string;
  effects: DeviceMqttEffect[];
  physicalDiscoveries?: Array<Omit<PhysicalDeviceDiscovery, 'scope'>>;
}

export interface DeviceMqttMessageAdapter {
  readonly id: string;

  subscriptions(prefix: string): string[];

  handle(message: DeviceMqttMessage): DeviceMqttAdapterResult | null;
}
