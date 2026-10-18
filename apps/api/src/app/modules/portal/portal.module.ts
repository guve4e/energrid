import { Module } from '@nestjs/common'
import { LlmGatewayService, OpenAiDeviceLlmProvider } from '../llm/llm-gateway.service'
import { DeviceAiInvestigationService } from '../llm/device-ai-investigation.service'
import { DeviceInvestigationHistoryStore } from '../llm/device-investigation-history.store'
import { PortalController } from './portal.controller'
import { PortalDeviceProxyService } from './portal-device-proxy.service'
import { PortalStateService } from './portal-state.service'
import { DevicesModule } from '../devices/devices.module'
import { PortalWeatherController } from './portal-weather.controller'

@Module({
  imports: [DevicesModule],
  controllers: [PortalController, PortalWeatherController],
  providers: [
    PortalStateService,
    PortalDeviceProxyService,
    OpenAiDeviceLlmProvider,
    {
      provide: LlmGatewayService,
      inject: [OpenAiDeviceLlmProvider],
      useFactory: (openai: OpenAiDeviceLlmProvider) => {
        const gateway = new LlmGatewayService()
        gateway.registerProvider(openai)
        return gateway
      },
    },
    DeviceAiInvestigationService,
    DeviceInvestigationHistoryStore,
  ],
})
export class PortalModule {}
