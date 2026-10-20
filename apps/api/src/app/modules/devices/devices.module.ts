import { Module } from '@nestjs/common'
import { DeviceControlService } from './device-control.service'
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
import { DeviceDiscoveryMemoryStore } from './device-discovery-memory.store'
import { TelemetryModule } from '../telemetry/telemetry.module'
import { ApprovedMqttObservationRuntime } from './mqtt/approved-mqtt-observation.runtime'
import { MqttEvidenceCaptureService } from './mqtt/mqtt-evidence-capture.service'
import { MqttEvidenceDiscoveryService } from './mqtt/mqtt-evidence-discovery.service'
import { MqttBrokerAttributionService } from './mqtt/mqtt-broker-attribution.service'
import { DeviceEnrollmentModule } from './enrollment/device-enrollment.module'

@Module({
  imports: [TelemetryModule, DeviceEnrollmentModule],
  providers: [
    DeviceRegistryService,
    ApprovedMqttObservationRuntime,
    DeviceMqttIngestService,
    MqttEvidenceCaptureService,
    MqttEvidenceDiscoveryService,
    MqttBrokerAttributionService,
    DeviceHttpPollService,
    DeviceLanNetworkEvidenceCollector,
    DeviceLanDiscoveryService,
    DeviceDiscoveryMemoryStore,
    DeviceControlService,
    DeviceDiagnosticsService,
    OperationalLogService,
    DeviceObservationService,
    DeviceMatchService,
    DeviceHealthService,
    DeviceInvestigationService,
    DeviceInstallationStore
  ],
  exports: [
    DeviceRegistryService,
    DeviceMqttIngestService,
    MqttEvidenceCaptureService,
    DeviceLanDiscoveryService,
    DeviceDiscoveryMemoryStore,
    DeviceControlService,
    DeviceDiagnosticsService,
    OperationalLogService,
    DeviceObservationService,
    DeviceMatchService,
    DeviceHealthService,
    DeviceInvestigationService,
    DeviceInstallationStore
  ],
})
export class DevicesModule {}
