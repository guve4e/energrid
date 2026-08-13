import { Injectable } from '@nestjs/common';
import type { NetworkDiscoveredDevice, RegisteredDevice } from './device-registry.types';
import { DeviceRegistryService } from './device-registry.service';
import type { DeviceMemory } from './device-observation.service';
import type { DeviceHealthSnapshot } from './device-health.service';

export type DeviceDiagnosticCategory =
  | 'healthy'
  | 'discovered_not_registered'
  | 'missing_telemetry'
  | 'offline'
  | 'unknown';

export interface DeviceDiagnostic {
  deviceId: string;
  category: DeviceDiagnosticCategory;
  severity: 'info' | 'warning' | 'error';
  evidence: {
    network: {
      detected: boolean;
      protocol?: string;
      vendor?: string;
      model?: string;
      ipAddress?: string;
    };
    registry: {
      registered: boolean;
      deviceId?: string;
    };
    telemetry: {
      received: boolean;
      lastSeen?: string;
    };
  };
  recommendation?: string;

  match?: {
    confidence: number;
    reason: string;
  };

  explanation: string;
}

@Injectable()
export class DeviceInvestigationService {

  constructor(
    private readonly registry: DeviceRegistryService,
  ) {}

  analyze(input: {
    networkDevices: NetworkDiscoveredDevice[];
    registeredDevices: RegisteredDevice[];
    memory: DeviceMemory[];
    health: DeviceHealthSnapshot[];
  }): DeviceDiagnostic[] {

    const diagnostics: DeviceDiagnostic[] = [];

    const approvedIds = new Set(
      input.registeredDevices
        .filter(device => device.trustStatus === 'approved')
        .map(device => device.id)
    );

    const memoryIds = new Set(
      input.memory.map(item => item.deviceId)
    );

    for (const network of input.networkDevices) {

      if (!approvedIds.has(network.id)) {

        if (network.vendor === 'Shelly') {
          this.registry.registerDiscoveredDevice({
            id: network.id,
            displayName:
              `${network.vendor} ${network.model || 'device'}`,
            suggestedName: network.id,
            protocol:
              network.protocol === 'unknown'
                ? 'http'
                : network.protocol,
            transport:
              network.protocol === 'http'
                ? 'http'
                : undefined,
            driver: 'shelly-rpc',
            target: network.ipAddress,
            capabilities: ['switch'],
            source: 'http',
            confidence: network.confidence,
            reason:
              'Discovered by LAN investigation.',
          });
        }

        diagnostics.push({
          deviceId: network.id,
          category: 'discovered_not_registered',
          severity: 'info',
          evidence: {
            network: {
              detected: true,
              protocol: network.protocol,
              vendor: network.vendor,
              model: network.model,
              ipAddress: network.ipAddress,
            },
            registry: {
              registered: false,
            },
            telemetry: {
              received: memoryIds.has(network.id),
            },
          },
          recommendation:
            network.vendor === 'Shelly'
              ? 'Create Shelly device profile and approve onboarding'
              : 'Review unknown network device',

          match:
            network.vendor === 'Shelly'
              ? {
                  confidence: 0.8,
                  reason:
                    'Shelly device discovered but no matching approved profile exists',
                }
              : undefined,

          explanation:
            `${network.vendor || 'Unknown device'} discovered on LAN but not registered`,
        });
      }
    }

    for (const health of input.health) {

      if (health.status !== 'healthy') {
        diagnostics.push({
          deviceId: health.deviceId,
          category:
            health.status === 'unreachable'
              ? 'offline'
              : 'missing_telemetry',
          severity:
            health.status === 'unreachable'
              ? 'error'
              : 'warning',
          evidence: {
            network: {
              detected: false,
            },
            registry: {
              registered: true,
              deviceId: health.deviceId,
            },
            telemetry: {
              received: false,
            },
          },
          explanation: health.reason,
        });
      }
    }

    return diagnostics;
  }
}
