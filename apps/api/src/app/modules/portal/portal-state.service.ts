import { Injectable } from '@nestjs/common';
import { DeviceLanDiscoveryService } from '../devices/device-lan-discovery.service';
import {
  DeviceMqttIngestService,
  type MqttDebugState,
} from '../devices/device-mqtt-ingest.service';
import { DeviceRegistryService } from '../devices/device-registry.service';
import type {
  DeviceRegistrySnapshot,
  NetworkDiscoveredDevice,
  NetworkDiscoveryZone,
  RegisteredDevice,
  SiteSystem,
} from '../devices/device-registry.types';

export interface PortalState {
  tenant: {
    id: string;
    name: string;
  };
  site: {
    id: string;
    name: string;
    mode: 'home' | 'away' | 'night';
  };
  sites: DeviceRegistrySnapshot['sites'];
  gateways: DeviceRegistrySnapshot['gateways'];
  zones: Array<{
    id: string;
    name: string;
    sensors: Array<{
      id: string;
      name: string;
      capability: 'temperature' | 'humidity' | 'motion' | 'power';
      value: number | boolean | null;
      unit?: string;
      observedAt: string;
      source: string;
    }>;
  }>;
  devices: RegisteredDevice[];
  networkZones: NetworkDiscoveryZone[];
  networkDevices: NetworkDiscoveredDevice[];
  systems: SiteSystem[];
  deviceSummary: DeviceRegistrySnapshot['summary'];
  voice: {
    websocketPath: string;
    provider: string;
  };
  bus: {
    mqtt: MqttDebugState;
  };
}

@Injectable()
export class PortalStateService {
  constructor(
    private readonly deviceRegistry: DeviceRegistryService,
    private readonly lanDiscovery: DeviceLanDiscoveryService,
    private readonly mqttIngest: DeviceMqttIngestService,
  ) {}

  getState(): PortalState {
    const registry = this.deviceRegistry.getSnapshot();

    return {
      tenant: {
        id: process.env.PORTAL_TENANT_ID || 'tenant-demo',
        name: process.env.PORTAL_TENANT_NAME || 'Energrid Demo',
      },
      site: {
        id: registry.site.id,
        name: registry.site.name,
        mode:
          (process.env.PORTAL_SITE_MODE as PortalState['site']['mode']) ||
          'home',
      },
      sites: registry.sites,
      gateways: registry.gateways,
      zones: registry.zones.map((zone) => ({
        id: zone.id,
        name: zone.name,
        sensors: registry.devices
          .filter((device) => zone.deviceIds.includes(device.id))
          .flatMap((device) =>
            device.capabilities
              .filter((capability) => capability.actions.includes('read'))
              .map((capability) => ({
                id: device.id,
                name: device.displayName,
                capability: capability.kind as
                  | 'temperature'
                  | 'humidity'
                  | 'motion'
                  | 'power',
                value: readDeviceSensorValue(device, capability.kind),
                unit: capability.unit,
                observedAt: device.state.observedAt || new Date().toISOString(),
                source: device.state.source,
              })),
          ),
      })),
      devices: registry.devices,
      networkZones: this.lanDiscovery.getZones(),
      networkDevices: this.lanDiscovery.getLastScan(),
      systems: registry.systems,
      deviceSummary: registry.summary,
      voice: {
        websocketPath: '/voice',
        provider:
          process.env.VOICE_STT_PROVIDER ||
          process.env.STT_PROVIDER ||
          'openai',
      },
      bus: {
        mqtt: this.mqttIngest.getDebugState(),
      },
    };
  }
}

function readDeviceSensorValue(
  device: RegisteredDevice,
  capability: string,
): number | boolean | null {
  const value = device.state.values[capability];

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  return null;
}
