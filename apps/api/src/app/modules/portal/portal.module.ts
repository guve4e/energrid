import { Module } from '@nestjs/common'
import { PortalController } from './portal.controller'
import { PortalDeviceProxyService } from './portal-device-proxy.service'
import { PortalStateService } from './portal-state.service'
import { DevicesModule } from '../devices/devices.module'

@Module({
  imports: [DevicesModule],
  controllers: [PortalController],
  providers: [PortalStateService, PortalDeviceProxyService],
})
export class PortalModule {}
