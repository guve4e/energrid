import type { DeviceEnrollmentIdentity } from '@energrid/domain-devices';
import type { DeviceCapabilityKind, DeviceProtocol } from '../device-registry.types';

export interface PhysicalDeviceScope {
  tenantId: string;
  siteId: string;
}

export interface PhysicalDeviceIdentityEvidence {
  namespace: string;
  value: string;
}

export interface PhysicalDeviceComponentEvidence {
  key: string;
  capabilities: DeviceCapabilityKind[];
}

export interface PhysicalDeviceEndpointEvidence {
  protocol: DeviceProtocol;
  kind: string;
  address: string;
}

export interface PhysicalDeviceDiscovery {
  scope: PhysicalDeviceScope;
  physicalDeviceId?: string;
  identity: PhysicalDeviceIdentityEvidence;
  vendor?: string;
  hardwareModel?: string;
  firmwareVersion?: string;
  evidenceSource: string;
  observedAt: string;
  components: PhysicalDeviceComponentEvidence[];
  endpoint?: PhysicalDeviceEndpointEvidence;
}

export interface PhysicalDeviceComponent {
  key: string;
  capabilities: DeviceCapabilityKind[];
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface PhysicalDeviceEndpoint {
  protocol: DeviceProtocol;
  kind: string;
  address: string;
  lastSeenAt: string;
}

export interface PhysicalLanObservation {
  physicalDeviceId: string;
  ipAddress: string;
  macAddress?: string;
  hostname?: string;
  gatewayId?: string;
  networkScope: string;
  observedAt: string;
  evidenceSource: string;
}

export interface PhysicalDeviceNetworkObservation {
  id: string;
  physicalDeviceId: string;
  ipAddress: string;
  macAddress?: string;
  hostname?: string;
  gatewayId?: string;
  networkScope: string;
  observedAt: string;
  evidenceSource: string;
  verificationStatus: 'protocol_observed' | 'user_confirmed' | 'hardware_verified';
  associatedAt: string | null;
  associatedBy: string | null;
  isCurrent: boolean;
}

export interface LogicalComponentAssignment {
  deviceId: string;
  physicalDeviceId: string;
  componentKey?: string;
  role?: string;
  assignedAt: string;
  assignedBy: string;
}

export interface PhysicalDeviceInventoryRecord {
  physicalDeviceId: string;
  scope: PhysicalDeviceScope;
  identity?: PhysicalDeviceIdentityEvidence;
  identityEvidenceSource?: string;
  identityLastObservedAt?: string;
  vendor?: string;
  hardwareModel?: string;
  firmwareVersion?: string;
  verificationStatus: 'not_identified' | 'protocol_observed' | 'user_confirmed' | 'hardware_verified';
  firstSeenAt: string;
  lastSeenAt: string;
  components: PhysicalDeviceComponent[];
  endpoints: PhysicalDeviceEndpoint[];
  networkObservations: PhysicalDeviceNetworkObservation[];
  assignments: LogicalComponentAssignment[];
}

export interface PhysicalDeviceInventoryRepository {
  discover(input: PhysicalDeviceDiscovery): Promise<PhysicalDeviceInventoryRecord>;
  discoverLanIdentity(input: {
    scope: PhysicalDeviceScope;
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
    associatedAt: string;
    associatedBy: string;
    device: DeviceEnrollmentIdentity;
    physicalDeviceId?: string;
  }): Promise<PhysicalDeviceInventoryRecord>;
  assignComponent(input: {
    scope: PhysicalDeviceScope;
    device: DeviceEnrollmentIdentity;
    physicalDeviceId: string;
    componentKey?: string;
    role?: string;
    assignedAt: string;
    assignedBy: string;
  }): Promise<PhysicalDeviceInventoryRecord>;
  refreshNetworkObservations(scope: PhysicalDeviceScope, observations: PhysicalLanObservation[]): Promise<void>;
  get(scope: PhysicalDeviceScope, physicalDeviceId: string): Promise<PhysicalDeviceInventoryRecord | null>;
  forLogicalDevice(scope: PhysicalDeviceScope, deviceId: string): Promise<PhysicalDeviceInventoryRecord | null>;
  list(scope: PhysicalDeviceScope): Promise<PhysicalDeviceInventoryRecord[]>;
}
