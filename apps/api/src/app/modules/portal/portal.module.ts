import { Module } from '@nestjs/common'
import { LlmGatewayService, OpenAiDeviceLlmProvider } from '../llm/llm-gateway.service'
import { DeviceAiInvestigationService } from '../llm/device-ai-investigation.service'
import { NetworkEndpointInvestigatorService } from '../llm/network-endpoint-investigator.service'
import { DeviceInvestigationWorkflowService } from '../llm/device-investigation-workflow.service'
import { ReadOnlyHttpIdentityProbe } from '../llm/read-only-http-identity-probe'
import { DeviceInvestigationHistoryStore } from '../llm/device-investigation-history.store'
import { PortalController } from './portal.controller'
import { PortalDeviceProxyService } from './portal-device-proxy.service'
import { PortalStateService } from './portal-state.service'
import { DeviceOnboardingService } from './device-onboarding.service'
import { DevicesModule } from '../devices/devices.module'
import { DeviceEnrollmentModule } from '../devices/enrollment/device-enrollment.module'
import { PortalWeatherController } from './portal-weather.controller'

@Module({
  imports: [DevicesModule, DeviceEnrollmentModule],
  controllers: [PortalController, PortalWeatherController],
  providers: [
    PortalStateService,
    PortalDeviceProxyService,
    DeviceOnboardingService,
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
    NetworkEndpointInvestigatorService,
    { provide: ReadOnlyHttpIdentityProbe, useFactory: () => new ReadOnlyHttpIdentityProbe() },
    DeviceInvestigationWorkflowService,
    DeviceInvestigationHistoryStore,
  ],
})
export class PortalModule {}
