import { Inject } from '@nestjs/common';
import { DEVICE_ENROLLMENT_SERVICE } from './enrollment/device-enrollment.module';
import { Injectable } from '@nestjs/common';
import { AuthorizedDeviceObservationReader } from './device-intelligence-observation-reader';
import {
  projectAuthorizedObservations,
  type IntelligenceObservationResult,
} from './device-intelligence-observation';
import { DeviceRegistryService } from './device-registry.service';
import { DeviceInstallationStore } from './device-installation.store';
import { DeviceEnrollmentService } from './enrollment/device-enrollment.service';

export interface IntelligenceScope {
  tenantId: string;
  siteId: string;
}

export interface IntelligenceDeviceDescription {
  deviceId: string;
  displayName: string;
  capabilities: unknown[];
  assistantEnabled: boolean;
}

@Injectable()
export class DeviceIntelligenceQueryService {
  constructor(
    private readonly registry: DeviceRegistryService,
    private readonly installations: DeviceInstallationStore,
    @Inject(DEVICE_ENROLLMENT_SERVICE)
    private readonly enrollment: DeviceEnrollmentService,
    private readonly observationReader: AuthorizedDeviceObservationReader,
  ) {}

  async listDevices(
    scope: IntelligenceScope,
  ): Promise<IntelligenceDeviceDescription[]> {
    if (!scope.tenantId?.trim() || !scope.siteId?.trim()) {
      throw new Error('Tenant and site are required');
    }

    await this.registry.ensureInstallationsLoaded();

    const result: IntelligenceDeviceDescription[] = [];

    for (const device of this.registry.getDevices()) {
      if (
        device.tenantId !== scope.tenantId ||
        device.siteId !== scope.siteId ||
        device.kind !== 'physical' ||
        device.trustStatus !== 'approved'
      ) continue;

      const installation = await this.installations.get(
        scope.siteId,
        device.id,
      );

      if (
        !installation ||
        installation.schemaVersion !== 1 ||
        installation.device.id !== device.id ||
        installation.device.tenantId !== scope.tenantId ||
        installation.device.siteId !== scope.siteId ||
        installation.device.trustStatus !== 'approved'
      ) continue;

      const enrolled = await this.enrollment.find({
        tenantId: scope.tenantId,
        siteId: scope.siteId,
        deviceId: device.id,
      });

      if (!enrolled || enrolled.status !== 'enrolled') continue;

      result.push({
        deviceId: device.id,
        displayName: device.displayName,
        capabilities: Array.isArray(device.capabilities)
          ? device.capabilities
          : [],
        assistantEnabled: device.assistantEnabled === true,
      });
    }

    return result.sort((a, b) =>
      a.displayName.localeCompare(b.displayName) ||
      a.deviceId.localeCompare(b.deviceId)
    );
  }

  async readObservations(
    scope: IntelligenceScope,
    deviceQuery: string,
  ): Promise<IntelligenceObservationResult | null> {
    const device = await this.describeDevice(scope, deviceQuery);
    if (!device) return null;

    // Reader is responsible for approved field/source authority.
    // Registry display state is deliberately NOT used.
    const state = await this.observationReader.read(
      scope,
      device.deviceId,
    );
    if (!state || state.deviceId !== device.deviceId) return null;

    const configured = Number(
      process.env.HOME_OBSERVATION_FRESHNESS_SECONDS || 60,
    );
    const freshnessSeconds = Number.isFinite(configured)
      ? Math.min(86400, Math.max(1, Math.floor(configured)))
      : 60;

    return projectAuthorizedObservations(state, freshnessSeconds);
  }

  async describeDevice(
    scope: IntelligenceScope,
    query: string,
  ): Promise<IntelligenceDeviceDescription | null> {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return null;

    const devices = await this.listDevices(scope);

    const exact = devices.find(
      device => device.deviceId.toLowerCase() === normalized,
    );
    if (exact) return exact;

    const matches = devices.filter(device =>
      device.displayName.toLowerCase().includes(normalized)
    );

    return matches.length === 1 ? matches[0] : null;
  }
}
