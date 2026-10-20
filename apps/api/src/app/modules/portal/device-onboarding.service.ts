import {
  ConflictException,
  Injectable,
  Inject,
  NotFoundException,
  Optional,
} from '@nestjs/common';

import type { RegisteredDevice } from '../devices/device-registry.types';
import { DeviceRegistryService } from '../devices/device-registry.service';
import { DeviceEnrollmentService } from '../devices/enrollment/device-enrollment.service';
import { DEVICE_ENROLLMENT_SERVICE } from '../devices/enrollment/device-enrollment.module';
import { PHYSICAL_DEVICE_INVENTORY_SERVICE } from '../devices/enrollment/device-enrollment.module';
import type { PhysicalDeviceInventoryService } from '../devices/enrollment/physical-device-inventory.service';

/**
 * Coordinates explicit onboarding across the existing installation
 * store and PostgreSQL enrollment.
 *
 * Retrying the same approval can complete a partially saved installation.
 * This is NOT a distributed transaction.
 */
@Injectable()
export class DeviceOnboardingService {
  constructor(
    private readonly registry: DeviceRegistryService,
    @Inject(DEVICE_ENROLLMENT_SERVICE)
    private readonly enrollment: DeviceEnrollmentService,
    @Optional()
    @Inject(PHYSICAL_DEVICE_INVENTORY_SERVICE)
    private readonly physicalInventory?: PhysicalDeviceInventoryService,
  ) {}

  async approve(deviceId: string): Promise<RegisteredDevice> {
    const { tenant, site } = this.registry.getSnapshot();

    const candidate = this.registry.getDevices().find(
      device =>
        device.id === deviceId &&
        device.tenantId === tenant.id &&
        device.siteId === site.id,
    );

    if (!candidate) {
      throw new NotFoundException('Device candidate not found');
    }

    const pending = candidate.trustStatus === 'discovered';

    const retryable =
      candidate.trustStatus === 'approved' &&
      candidate.metadata?.approvedFromDiscovery === true;

    if (!pending && !retryable) {
      throw new ConflictException(
        'Device is not an eligible discovery candidate',
      );
    }

    const identity = {
      tenantId: tenant.id,
      siteId: site.id,
      deviceId: candidate.id,
    };

    const existing = await this.enrollment.find(identity);

    if (existing?.status === 'suspended') {
      throw new ConflictException(
        'Suspended enrollment requires explicit reactivation',
      );
    }

    if (existing?.status === 'retired' && !pending && !retryable) {
      throw new ConflictException(
        'Retired devices require an explicit discovery approval to reenroll',
      );
    }

    const approved = pending
      ? this.registry.approveDiscoveredDevice(candidate.id)
      : candidate;

    if (!approved) {
      throw new ConflictException(
        'Device discovery state changed during approval',
      );
    }

    // Persist the existing installation before declaring enrollment.
    // If this already succeeded, a retry does not repeat the approval.
    if (!approved.commissioning) {
      await this.registry.persistInstallation(approved, pending);
    }

    // PostgreSQL enrollment is the durable inventory decision.
    if (!existing) {
      await this.enrollment.enroll(
        {
          ...identity,
          displayName: approved.displayName,
        },
        'portal-control-token',
      );
    } else if (existing.status === 'retired') {
      await this.enrollment.reenroll(
        identity,
        approved.displayName,
        'portal-control-token',
      );
    }
    this.registry.setEnrollmentStatus(candidate.id, 'enrolled');

    const physicalId = approved.metadata?.physicalId;
    const componentKey = approved.metadata?.component;
    if (this.physicalInventory && typeof physicalId === 'string' && typeof componentKey === 'string') {
      const observedAt = approved.state.observedAt || new Date().toISOString();
      const mqttCommandTopic = approved.metadata?.mqttCommandTopic;
      const priorAssociation = await this.physicalInventory.forLogicalDevice(
        { tenantId: tenant.id, siteId: site.id }, approved.id,
      );
      const discovered = await this.physicalInventory.discover({
        scope: { tenantId: tenant.id, siteId: site.id },
        ...(priorAssociation ? { physicalDeviceId: priorAssociation.physicalDeviceId } : {}),
        identity: { namespace: 'mqtt:shelly-protocol-id', value: physicalId },
        evidenceSource: approved.adapter.driver === 'shelly-lan'
          ? 'lan_discovery_protocol_match'
          : 'mqtt_protocol_onboarding',
        observedAt,
        components: [{
          key: componentKey,
          capabilities: approved.capabilities.map(capability => capability.kind),
        }],
        ...(typeof mqttCommandTopic === 'string'
          ? { endpoint: { protocol: 'mqtt' as const, kind: 'command' as const, address: mqttCommandTopic } }
          : {}),
        ...(typeof approved.metadata?.httpBaseUrl === 'string'
          ? { endpoint: { protocol: 'http' as const, kind: 'rpc' as const, address: approved.metadata.httpBaseUrl } }
          : {}),
      });
      const ipAddress = approved.metadata?.ipAddress;
      const networkScope = approved.metadata?.networkScope;
      const networkObservedAt = approved.metadata?.networkObservedAt;
      if (typeof ipAddress === 'string' && typeof networkScope === 'string' &&
        typeof networkObservedAt === 'string') {
        await this.physicalInventory.associateLanIdentity({
          device: identity,
          physicalDeviceId: discovered.physicalDeviceId,
          ipAddress,
          networkScope,
          observedAt: networkObservedAt,
          evidenceSource: 'lan_discovery_protocol_match',
          actor: 'portal-control-token',
          ...(typeof approved.metadata?.macAddress === 'string'
            ? { macAddress: approved.metadata.macAddress }
            : {}),
          ...(typeof approved.metadata?.hostname === 'string'
            ? { hostname: approved.metadata.hostname }
            : {}),
          ...(typeof approved.metadata?.gatewayId === 'string'
            ? { gatewayId: approved.metadata.gatewayId }
            : {}),
        });
      }
      await this.physicalInventory.assignComponent({
        device: identity,
        physicalDeviceId: discovered.physicalDeviceId,
        componentKey,
        actor: 'portal-control-token',
      });
    }

    return this.registry.getDevices().find(
      device => device.id === candidate.id,
    ) ?? approved;
  }
}
