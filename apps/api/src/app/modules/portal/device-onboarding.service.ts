import {
  BadRequestException,
  ConflictException,
  Injectable,
  Inject,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { isIP } from 'node:net';

import type { RegisteredDevice } from '../devices/device-registry.types';
import { DeviceRegistryService } from '../devices/device-registry.service';
import { DeviceEnrollmentService } from '../devices/enrollment/device-enrollment.service';
import { DEVICE_ENROLLMENT_SERVICE } from '../devices/enrollment/device-enrollment.module';
import { PHYSICAL_DEVICE_INVENTORY_SERVICE } from '../devices/enrollment/device-enrollment.module';
import type { PhysicalDeviceInventoryService } from '../devices/enrollment/physical-device-inventory.service';
import { hasPhysicalDeviceIdentityClaim } from '../devices/enrollment/physical-device-inventory.repository';
import { normalizeMacAddress } from '../devices/mac-address';

export const SHELLY_ONBOARDING_EVIDENCE_MAX_AGE_MS = 15 * 60_000;

export type ShellyIdentityRecovery = {
  status: 'ready' | 'verification_required' | 'not_recoverable';
  reason: string;
  physicalDeviceId?: string;
  physicalId?: string;
  componentKey?: string;
};

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

  async getShellyIdentityRecovery(deviceId: string): Promise<ShellyIdentityRecovery> {
    const { tenant, site } = this.registry.getSnapshot();
    const device = this.registry.getDevices(true).find(item =>
      item.id === deviceId && item.tenantId === tenant.id && item.siteId === site.id,
    );
    if (!device || !isShellyCandidate(device) || device.trustStatus !== 'approved' ||
        device.metadata?.approvedFromDiscovery !== true ||
        device.metadata?.discoveryTenantId !== tenant.id ||
        device.metadata?.discoverySiteId !== site.id) {
      return { status: 'not_recoverable', reason: 'This is not an approved, site-owned discovery enrollment.' };
    }
    if (device.metadata?.requiresProfileReconciliation === true) {
      return { status: 'not_recoverable', reason: 'A historical component-profile conflict requires separate operator reconciliation before identity recovery.' };
    }
    if (!this.physicalInventory) {
      return { status: 'not_recoverable', reason: 'Physical Inventory is unavailable.' };
    }

    const physicalId = String(device.metadata?.physicalId || '');
    const componentKey = String(device.metadata?.component || '');
    if (device.id !== `${physicalId}:${componentKey}`) {
      return { status: 'not_recoverable', reason: 'The logical device ID does not match its protocol identity and component.' };
    }
    const identity = { tenantId: tenant.id, siteId: site.id, deviceId };
    const enrollment = await this.enrollment.find(identity);
    if (enrollment?.status !== 'enrolled') {
      return { status: 'not_recoverable', reason: 'The existing device is not actively enrolled.' };
    }

    const existingLink = await this.physicalInventory.forLogicalDevice(
      { tenantId: tenant.id, siteId: site.id }, deviceId,
    );
    let incompleteComponentAssignment = false;
    if (existingLink) {
      const assignment = existingLink.assignments.find(item => item.deviceId === deviceId);
      if (assignment?.physicalDeviceId === existingLink.physicalDeviceId && assignment.componentKey === componentKey) {
        return { status: 'not_recoverable', reason: 'The logical component is already linked.' };
      }
      if (assignment?.physicalDeviceId === existingLink.physicalDeviceId && !assignment.componentKey) {
        incompleteComponentAssignment = true;
      } else {
        return { status: 'not_recoverable', reason: 'An existing physical assignment conflicts with this component.' };
      }
    }

    const matches = (await this.physicalInventory.list({ tenantId: tenant.id, siteId: site.id })).filter(item =>
      item.scope.tenantId === tenant.id && item.scope.siteId === site.id &&
      hasPhysicalDeviceIdentityClaim(item, 'mqtt:shelly-protocol-id', physicalId),
    );
    if (matches.length !== 1) {
      return { status: 'not_recoverable', reason: matches.length
        ? 'Multiple same-site physical records match this protocol identity.'
        : 'The verified same-site physical inventory record is missing.' };
    }
    const physical = matches[0];
    const protocolIdentities = (physical.identities || (physical.identity ? [physical.identity] : []))
      .filter(identity => identity.namespace === 'mqtt:shelly-protocol-id');
    if (protocolIdentities.some(identity => identity.value.toLowerCase() !== physicalId.toLowerCase())) {
      return { status: 'not_recoverable', reason: 'The physical inventory record has conflicting Shelly protocol identities.' };
    }
    if (incompleteComponentAssignment && existingLink?.physicalDeviceId !== physical.physicalDeviceId) {
      return { status: 'not_recoverable', reason: 'The incomplete component assignment points to a different physical inventory record.' };
    }
    if (device.metadata?.physicalInventoryId !== undefined &&
        device.metadata.physicalInventoryId !== physical.physicalDeviceId) {
      return { status: 'not_recoverable', reason: 'The saved physical inventory ID conflicts with the protocol identity.' };
    }
    if (!physical.components.some(item => item.key === componentKey)) {
      return { status: 'not_recoverable', reason: `Physical Inventory does not contain ${componentKey}.` };
    }
    if (physical.assignments.some(item =>
      (item.componentKey === componentKey && item.deviceId !== deviceId) ||
      (item.deviceId === deviceId && (item.physicalDeviceId !== physical.physicalDeviceId ||
        (item.componentKey !== componentKey && !(incompleteComponentAssignment && !item.componentKey)))),
    )) {
      return { status: 'not_recoverable', reason: 'A physical component assignment conflicts with this enrollment.' };
    }

    const result = {
      physicalDeviceId: physical.physicalDeviceId,
      physicalId,
      componentKey,
    };
    return hasFreshVerifiedShellyLanEvidence(device)
      ? { status: 'ready', reason: 'Fresh identity and component evidence is available for the existing association.', ...result }
      : { status: 'verification_required', reason: 'Fresh selected-device RPC verification is required before the association can be completed.', ...result };
  }

  async approve(
    deviceId: string,
    placement?: { zoneId: string; zoneName: string },
    actor = 'portal-admin',
    profileConflictAcknowledged = false,
  ): Promise<RegisteredDevice> {
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

    if (isShellyCandidate(candidate) && !hasFreshVerifiedShellyLanEvidence(candidate)) {
      throw new ConflictException(
        'Fresh Shelly LAN identity and component RPC verification is required before enrollment; MQTT identity claims alone are not sufficient',
      );
    }
    if (candidate.trustStatus === 'discovered' && candidate.metadata?.requiresProfileReconciliation === true && !profileConflictAcknowledged) {
      throw new ConflictException('Historical Shelly component conflicts must be reviewed and explicitly acknowledged before enrollment.');
    }

    if (candidate.tenantId !== tenant.id || candidate.siteId !== site.id ||
        candidate.metadata?.discoveryTenantId !== tenant.id ||
        candidate.metadata?.discoverySiteId !== site.id) {
      throw new ConflictException(
        'Discovery evidence ownership does not match the authorized tenant and site',
      );
    }

    // Validate predictable LAN-association inputs before persisting the
    // installation or enrollment. This keeps malformed evidence from leaving
    // a partially enrolled device that can only be repaired by retry.
    if (isShellyCandidate(candidate)) {
      validateShellyLanAssociation(candidate);
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
      ? placement
        ? this.registry.approveDiscoveredDevice(candidate.id, placement)
        : this.registry.approveDiscoveredDevice(candidate.id)
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
        actor,
      );
    } else if (existing.status === 'retired') {
      await this.enrollment.reenroll(
        identity,
        approved.displayName,
        actor,
      );
    }
    this.registry.setEnrollmentStatus(candidate.id, 'enrolled');
    if (candidate.metadata?.requiresProfileReconciliation === true && profileConflictAcknowledged) {
      await this.registry.persistInstallationEvent(candidate.id, 'approved', {
        profileConflictAcknowledged: true,
        historicalComponents: String(candidate.metadata?.historicalComponentConflicts || ''),
        currentComponents: String(candidate.metadata?.component || ''),
      }, actor);
    }

    const physicalId = approved.metadata?.physicalId;
    const componentKey = approved.metadata?.component;
    const isEnergridFirmwareIdentity =
      approved.metadata?.identityEvidenceSource === 'bounded GET /api/v1/identity';
    if (this.physicalInventory && isEnergridFirmwareIdentity && typeof physicalId === 'string') {
      const observedAt = String(approved.metadata?.networkObservedAt || approved.state.observedAt || new Date().toISOString());
      const networkScope = String(approved.metadata?.networkScope || '');
      const ipAddress = String(approved.metadata?.ipAddress || '');
      const physical = await this.physicalInventory.discover({
        scope: identity,
        identity: {
          namespace: `energrid:firmware-device-id:${networkScope || 'network-unknown'}`,
          value: physicalId,
        },
        vendor: 'Energrid',
        hardwareModel: approved.displayName,
        firmwareVersion: String(approved.metadata?.firmwareVersion || ''),
        evidenceSource: 'bounded_http_identity',
        observedAt,
        components: [],
        ...(typeof approved.adapter.target === 'string'
          ? { endpoint: { protocol: 'http' as const, kind: 'status', address: approved.adapter.target } }
          : {}),
      });
      if (ipAddress && networkScope) {
        await this.physicalInventory.associateLanIdentity({
          device: identity,
          physicalDeviceId: physical.physicalDeviceId,
          ipAddress,
          networkScope,
          observedAt,
          evidenceSource: 'bounded_http_identity',
          actor,
          ...(typeof approved.metadata?.macAddress === 'string' ? { macAddress: approved.metadata.macAddress } : {}),
          ...(typeof approved.metadata?.hostname === 'string' ? { hostname: approved.metadata.hostname } : {}),
          ...(typeof approved.metadata?.gatewayId === 'string' ? { gatewayId: approved.metadata.gatewayId } : {}),
        });
      }
    }
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
          actor,
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
        actor,
      });
    }

    return this.registry.getDevices().find(
      device => device.id === candidate.id,
    ) ?? approved;
  }
}

function isShellyCandidate(device: RegisteredDevice): boolean {
  return typeof device.metadata?.physicalId === 'string' &&
    /^shelly[a-z0-9._-]{1,114}$/i.test(device.metadata.physicalId) &&
    typeof device.metadata?.component === 'string';
}

function validateShellyLanAssociation(device: RegisteredDevice): void {
  const { ipAddress, networkScope, networkObservedAt, macAddress } = device.metadata ?? {};
  if (macAddress !== undefined &&
    (typeof macAddress !== 'string' || !normalizeMacAddress(macAddress))) {
    throw new BadRequestException('LAN MAC evidence is invalid');
  }
  // The existing association path runs when these three values are present.
  // Validate their format before any enrollment write, without promoting MAC
  // evidence beyond its existing claimed/user-confirmed provenance.
  if (typeof ipAddress === 'string' && typeof networkScope === 'string' &&
    typeof networkObservedAt === 'string' &&
    (!isIP(ipAddress) || !networkScope.trim() || !Number.isFinite(Date.parse(networkObservedAt)))) {
    throw new BadRequestException('LAN identity evidence is invalid');
  }
}

function hasFreshVerifiedShellyLanEvidence(device: RegisteredDevice, now = Date.now()): boolean {
  const component = String(device.metadata?.component || '');
  const channel = /^(switch|em1):(\d+)$/.exec(component);
  const expectedMethod = channel
    ? `${channel[1] === 'switch' ? 'Switch' : 'EM1'}.GetStatus?id=${channel[2]}`
    : '';
  const identityAt = Date.parse(String(device.metadata?.identityVerifiedAt || ''));
  const componentAt = Date.parse(String(device.metadata?.componentVerifiedAt || ''));
  const direct = device.metadata?.identityEvidenceSource === 'verified_shelly_http_rpc' &&
    device.metadata?.componentEvidenceSource === 'verified_shelly_component_status_rpc';
  const siteLocal = device.metadata?.identityEvidenceSource === 'verified_site_local_shelly_rpc' &&
    device.metadata?.componentEvidenceSource === 'verified_site_local_shelly_rpc' &&
    typeof device.metadata?.siteLocalObserverId === 'string' &&
    String(device.metadata.siteLocalObserverId).length > 0;
  return device.adapter.driver === 'shelly-lan' &&
    (direct || siteLocal) &&
    device.metadata?.identityVerificationMethod === 'GET /rpc/Shelly.GetDeviceInfo' &&
    device.metadata?.componentVerificationMethod === expectedMethod &&
    Number.isFinite(identityAt) && Number.isFinite(componentAt) &&
    identityAt <= now && componentAt <= now &&
    now - identityAt <= SHELLY_ONBOARDING_EVIDENCE_MAX_AGE_MS &&
    now - componentAt <= SHELLY_ONBOARDING_EVIDENCE_MAX_AGE_MS;
}
