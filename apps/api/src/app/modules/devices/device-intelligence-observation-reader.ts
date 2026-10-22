import { Injectable } from '@nestjs/common';
import type { DeviceObservationState } from '@energrid/domain-devices';
import { ApprovedMqttObservationRuntime } from './mqtt/approved-mqtt-observation.runtime';

export interface ObservationQueryScope {
  tenantId: string;
  siteId: string;
}

/**
 * Core-facing read boundary.
 * Implementations return ONLY individually authorized fields.
 * Do not return merged registry display state here.
 */
export abstract class AuthorizedDeviceObservationReader {
  abstract read(
    scope: ObservationQueryScope,
    deviceId: string,
  ): Promise<DeviceObservationState | null>;
}

/**
 * Existing approved MQTT observation implementation.
 * Future protocol adapters must preserve the same authority guarantees.
 */
@Injectable()
export class ExistingApprovedObservationReader
  implements AuthorizedDeviceObservationReader {
  constructor(
    private readonly runtime: ApprovedMqttObservationRuntime,
  ) {}

  read(scope: ObservationQueryScope, deviceId: string) {
    return this.runtime.getAuthorizedObservation(scope, deviceId);
  }
}
