import { Module } from '@nestjs/common'
import { DeviceControlService } from './device-control.service'
import { DeviceHttpPollService } from './device-http-poll.service'
import { DeviceLanDiscoveryService } from './device-lan-discovery.service'
import { DeviceMqttIngestService } from './device-mqtt-ingest.service'
import { DeviceRegistryService } from './device-registry.service'
import { OperationalLogService } from './operational-log.service'

@Module({
  providers: [
    DeviceRegistryService,
    DeviceMqttIngestService,
    DeviceHttpPollService,
    DeviceLanDiscoveryService,
    DeviceControlService,
    OperationalLogService,
  ],
  exports: [
    DeviceRegistryService,
    DeviceMqttIngestService,
    DeviceLanDiscoveryService,
    DeviceControlService,
    OperationalLogService,
  ],
})
export class DevicesModule {}
