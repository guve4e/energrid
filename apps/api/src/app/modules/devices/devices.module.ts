import { AuthorizedDeviceObservationReader, ExistingApprovedObservationReader } from './device-intelligence-observation-reader';
import { deviceCommandTrackerProvider } from './commands/device-command-tracker.provider';
import { DeviceIntelligenceQueryService } from './device-intelligence-query.service';
import { Module } from '@nestjs/common'
import { DeviceControlService } from './device-control.service'
import { DeviceAssistantLightingService } from './device-assistant-lighting.service'
import { DeviceDiagnosticsService } from './device-diagnostics.service'
import { DeviceHttpPollService } from './device-http-poll.service'
import {
  DeviceLanDiscoveryService,
  DeviceLanNetworkEvidenceCollector,
} from './device-lan-discovery.service'
import { DeviceMqttIngestService } from './device-mqtt-ingest.service'
import { DeviceRegistryService } from './device-registry.service'
import { OperationalLogService } from './operational-log.service'
import { DeviceHealthService } from './device-health.service'
import { DeviceObservationService } from './device-observation.service'
import { DeviceMatchService } from './device-match.service'
import { DeviceInvestigationService } from './device-investigation.service'
import { DeviceInstallationStore } from './device-installation.store'
import { DeviceFirmwareDiagnosticsService } from './device-firmware-diagnostics'
import { DeviceHealthAssistantQueryService } from './device-health-assistant-query.service'
import { DeviceDiscoveryMemoryStore } from './device-discovery-memory.store'
import { DEVICE_DISCOVERY_MEMORY_STORE, DEVICE_REGISTRY_SERVICE } from './device-runtime.tokens'
import { TelemetryModule } from '../telemetry/telemetry.module'
import { ApprovedMqttObservationRuntime } from './mqtt/approved-mqtt-observation.runtime'
import { MqttEvidenceCaptureService } from './mqtt/mqtt-evidence-capture.service'
import { MqttEvidenceDiscoveryService } from './mqtt/mqtt-evidence-discovery.service'
import { MqttBrokerAttributionService } from './mqtt/mqtt-broker-attribution.service'
import { DeviceEnrollmentModule } from './enrollment/device-enrollment.module'
import { NmapNetworkEvidenceAdapter } from './adapters/outbound/network/nmap-network-evidence.adapter'
import { LocalNetworkRuntimeAdapter } from './adapters/outbound/network/local-network-runtime.adapter'
import { EnergridHttpIdentityAdapter } from './adapters/outbound/network/energrid-http-identity.adapter'

@Module({
  imports: [TelemetryModule, DeviceEnrollmentModule],
  providers: [
    deviceCommandTrackerProvider,
    DeviceRegistryService,
    { provide: DEVICE_REGISTRY_SERVICE, useExisting: DeviceRegistryService },
    ApprovedMqttObservationRuntime,
    DeviceMqttIngestService,
    MqttEvidenceCaptureService,
    MqttEvidenceDiscoveryService,
    MqttBrokerAttributionService,
    DeviceHttpPollService,
    DeviceLanNetworkEvidenceCollector,
    NmapNetworkEvidenceAdapter,
    EnergridHttpIdentityAdapter,
    { provide: LocalNetworkRuntimeAdapter, useFactory: () => new LocalNetworkRuntimeAdapter() },
    DeviceLanDiscoveryService,
    DeviceDiscoveryMemoryStore,
    { provide: DEVICE_DISCOVERY_MEMORY_STORE, useExisting: DeviceDiscoveryMemoryStore },
    DeviceControlService,
    DeviceAssistantLightingService,
    DeviceDiagnosticsService,
    OperationalLogService,
    DeviceObservationService,
    DeviceIntelligenceQueryService,
    { provide: AuthorizedDeviceObservationReader, useClass: ExistingApprovedObservationReader },
    DeviceMatchService,
    DeviceHealthService,
    DeviceInvestigationService,
    DeviceInstallationStore,
    DeviceFirmwareDiagnosticsService,
    DeviceHealthAssistantQueryService,
  ],
  exports: [
    AuthorizedDeviceObservationReader,
    DeviceRegistryService,
    DEVICE_REGISTRY_SERVICE,
    ApprovedMqttObservationRuntime,
    DeviceMqttIngestService,
    MqttEvidenceCaptureService,
    DeviceLanDiscoveryService,
    DeviceHttpPollService,
    DeviceDiscoveryMemoryStore,
    DEVICE_DISCOVERY_MEMORY_STORE,
    DeviceControlService,
    DeviceAssistantLightingService,
    DeviceDiagnosticsService,
    OperationalLogService,
    DeviceObservationService,
    DeviceIntelligenceQueryService,
    DeviceMatchService,
    DeviceHealthService,
    DeviceInvestigationService,
    DeviceInstallationStore,
    DeviceFirmwareDiagnosticsService,
    DeviceHealthAssistantQueryService,
  ],
})
export class DevicesModule {}
