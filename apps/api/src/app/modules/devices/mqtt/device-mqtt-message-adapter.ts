export interface DeviceMqttMessage {
  topic: string;
  payload: unknown;
  payloadText: string;
}

export type DeviceMqttEffect =
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
}

export interface DeviceMqttMessageAdapter {
  readonly id: string;

  subscriptions(prefix: string): string[];

  handle(message: DeviceMqttMessage): DeviceMqttAdapterResult | null;
}
