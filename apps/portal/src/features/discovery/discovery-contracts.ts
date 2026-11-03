// Network evidence is read-only. A presence record never grants enrollment or control.
export type DiscoveryNetworkZone = {
  id: string;
  name: string;
  cidr?: string;
  interfaceName?: string;
  seedIps: string[];
  role?: string;
  collectionSource?: 'local' | 'virtual-lab';
};
export type NetworkDevice = {
  id: string;
  ipAddress: string;
  networkZoneId: string;
  networkZoneName: string;
  macAddress?: string;
  deviceReportedMacAddress?: string;
  macVendorClue?: { status: 'matched'; vendor: string; prefix: string; assignmentType: string; databaseVersion: string; source: string; classification: string };
  identityConflict?: {
    reason: 'multiple_macs_for_endpoint';
    macAddresses: string[];
  };
  hostname?: string;
  vendor?: string;
  protocol: string;
  confidence: number;
  status: string;
  settingsUrl?: string;
  model?: string;
  app?: string;
  generation?: number;
  components?: Array<{ component: string; channel: number }>;
  discoveredAt: string;
  reason: string;
  observations?: Array<{
    source: 'icmp' | 'dns' | 'tcp' | 'http_rpc';
    attribute: string;
    value: string | number | boolean;
    observedAt: string;
  }>;
};

export type KnownNetworkDevice = {
  schemaVersion: 1;
  identity: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastScanId: string;
  device: NetworkDevice;
};

export type DiscoveryMemoryResponse = {
  summary: {
    lastScanId: string | null;
    known: number;
    observedInLatestScan: number;
    notObservedInLatestScan: number;
  };
  devices: KnownNetworkDevice[];
};

export type SnapshotMarker = { completedAt: string; methods: string[] };
