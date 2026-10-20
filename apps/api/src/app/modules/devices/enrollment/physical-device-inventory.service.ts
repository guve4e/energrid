import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { isIP } from 'node:net';
import type { DeviceEnrollmentIdentity } from '@energrid/domain-devices';
import type { DeviceEnrollmentService } from './device-enrollment.service';
import type {
  PhysicalDeviceDiscovery,
  PhysicalDeviceInventoryRecord,
  PhysicalDeviceInventoryRepository,
  PhysicalLanObservation,
  PhysicalDeviceScope,
} from './physical-device-inventory.repository';

export class PhysicalDeviceInventoryService {
  constructor(
    private readonly repository: PhysicalDeviceInventoryRepository,
    private readonly enrollment?: DeviceEnrollmentService,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async discover(input: PhysicalDeviceDiscovery): Promise<PhysicalDeviceInventoryRecord> {
    validateDiscovery(input);
    return this.repository.discover(input);
  }

  get(scope: PhysicalDeviceScope, physicalDeviceId: string) {
    return this.repository.get(scope, physicalDeviceId);
  }

  list(scope: PhysicalDeviceScope) {
    return this.repository.list(scope);
  }

  refreshNetworkObservations(scope: PhysicalDeviceScope, observations: PhysicalLanObservation[]) {
    return this.repository.refreshNetworkObservations(scope, observations);
  }

  forLogicalDevice(scope: PhysicalDeviceScope, deviceId: string) {
    return this.repository.forLogicalDevice(scope, deviceId);
  }

  async associateLanIdentity(input: {
    device: DeviceEnrollmentIdentity;
    networkScope: string;
    ipAddress: string;
    macAddress?: string;
    hostname?: string;
    vendor?: string;
    hardwareModel?: string;
    firmwareVersion?: string;
    gatewayId?: string;
    observedAt: string;
    evidenceSource: string;
    actor: string;
    physicalDeviceId?: string;
  }): Promise<PhysicalDeviceInventoryRecord> {
    if (!this.enrollment) throw new NotFoundException('Enrollment service is unavailable');
    const macAddress = normalizeMac(input.macAddress);
    if (!input.actor.trim() || !input.networkScope.trim() || !isIP(input.ipAddress) ||
      !input.evidenceSource.trim() || !Number.isFinite(Date.parse(input.observedAt))) {
      throw new BadRequestException('LAN identity evidence is invalid');
    }
    const enrolled = await this.enrollment.find(input.device);
    if (!enrolled || enrolled.status !== 'enrolled') {
      throw new NotFoundException('Enrolled device was not found');
    }

    try {
      return await this.repository.discoverLanIdentity({
        scope: { tenantId: input.device.tenantId, siteId: input.device.siteId },
        networkScope: input.networkScope,
        ipAddress: input.ipAddress,
        ...(macAddress ? { macAddress } : {}),
        ...(input.hostname ? { hostname: input.hostname } : {}),
        ...(input.vendor ? { vendor: input.vendor } : {}),
        ...(input.hardwareModel ? { hardwareModel: input.hardwareModel } : {}),
        ...(input.firmwareVersion ? { firmwareVersion: input.firmwareVersion } : {}),
        ...(input.gatewayId ? { gatewayId: input.gatewayId } : {}),
        observedAt: input.observedAt,
        evidenceSource: input.evidenceSource,
        associatedAt: this.now(),
        associatedBy: input.actor,
        device: input.device,
        ...(input.physicalDeviceId ? { physicalDeviceId: input.physicalDeviceId } : {}),
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('already associated')) {
        throw new ConflictException(error.message);
      }
      throw error;
    }
  }

  async assignComponent(input: {
    device: DeviceEnrollmentIdentity;
    physicalDeviceId: string;
    componentKey?: string;
    role?: string;
    actor: string;
  }): Promise<PhysicalDeviceInventoryRecord> {
    if (!this.enrollment) throw new NotFoundException('Enrollment service is unavailable');
    if (!input.actor.trim() || !input.physicalDeviceId.trim() ||
      (input.componentKey !== undefined && !input.componentKey.trim())) {
      throw new BadRequestException('Component assignment is invalid');
    }
    const enrolled = await this.enrollment.find(input.device);
    if (!enrolled || enrolled.status !== 'enrolled') {
      throw new NotFoundException('Enrolled device was not found');
    }
    try {
      return await this.repository.assignComponent({
        scope: { tenantId: input.device.tenantId, siteId: input.device.siteId },
        device: input.device,
        physicalDeviceId: input.physicalDeviceId,
        ...(input.componentKey ? { componentKey: input.componentKey } : {}),
        ...(input.role?.trim() ? { role: input.role.trim() } : {}),
        assignedAt: this.now(),
        assignedBy: input.actor.trim(),
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('already assigned')) {
        throw new ConflictException(error.message);
      }
      throw error;
    }
  }
}

function validateDiscovery(input: PhysicalDeviceDiscovery): void {
  if (!input?.scope?.tenantId?.trim() || !input.scope.siteId?.trim() ||
    !input.identity?.namespace?.trim() || !input.identity.value?.trim() ||
    input.identity.namespace.toLowerCase() === 'ip' ||
    /^(ip|ip-address|hostname|host|mqtt-prefix|topic|manufacturer)$/i.test(input.identity.namespace) ||
    isIP(input.identity.value.trim()) || !input.evidenceSource?.trim() ||
    !Number.isFinite(Date.parse(input.observedAt))) {
    throw new BadRequestException('Stable protocol identity evidence is required');
  }
  if (!Array.isArray(input.components) || input.components.some(component =>
    !component.key?.trim() || !Array.isArray(component.capabilities))) {
    throw new BadRequestException('Protocol-identified components are required');
  }
  const keys = input.components.map(component => component.key.trim());
  if (new Set(keys).size !== keys.length) {
    throw new BadRequestException('Component keys must be unique');
  }
  if (input.endpoint && (!input.endpoint.protocol || !input.endpoint.kind?.trim() ||
    !input.endpoint.address?.trim() || containsCredential(input.endpoint.address))) {
    throw new BadRequestException('Communication endpoint evidence is invalid');
  }
}

function normalizeMac(value?: string): string | undefined {
  if (value === undefined) return undefined;
  const octets = value.trim().split(/[:-]/);
  if (octets.length !== 6 || octets.some(octet => !/^[0-9a-f]{1,2}$/i.test(octet))) {
    throw new BadRequestException('LAN MAC evidence is invalid');
  }
  return octets.map(octet => octet.padStart(2, '0').toLowerCase()).join(':');
}

function containsCredential(address: string): boolean {
  return /:\/\/[^/@]+:[^/@]+@/.test(address) ||
    /(?:password|passwd|token|secret|credential)=/i.test(address);
}
