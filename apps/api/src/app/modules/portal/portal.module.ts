import { HouseIntelligenceModule } from '../llm/house-intelligence.module'
import { Module } from '@nestjs/common'
import { LlmGatewayService, OpenAiDeviceLlmProvider } from '../llm/llm-gateway.service'
import { DeviceAiInvestigationService } from '../llm/device-ai-investigation.service'
import { NetworkEndpointInvestigatorService } from '../llm/network-endpoint-investigator.service'
import { DeviceInvestigationWorkflowService } from '../llm/device-investigation-workflow.service'
import { ReadOnlyHttpIdentityProbe } from '../llm/read-only-http-identity-probe'
import { NetworkEndpointIdentityRefresh } from '../llm/network-endpoint-identity-refresh'
import { refreshLocalNeighborIdentity } from '../devices/adapters/outbound/network/targeted-neighbor-identity.adapter'
import { DeviceInvestigationHistoryStore } from '../llm/device-investigation-history.store'
import { PortalController } from './portal.controller'
import { PortalDeviceProxyService } from './portal-device-proxy.service'
import { PortalStateService } from './portal-state.service'
import { DeviceOnboardingService } from './device-onboarding.service'
import { DevicesModule } from '../devices/devices.module'
import { DeviceEnrollmentModule } from '../devices/enrollment/device-enrollment.module'
import { PortalWeatherController } from './portal-weather.controller'
import { PortalDeviceMeasurementsService } from './portal-device-measurements.service'
import { TelemetryModule } from '../telemetry/telemetry.module'

@Module({
  imports: [DevicesModule, DeviceEnrollmentModule, HouseIntelligenceModule, TelemetryModule],
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
    { provide: NetworkEndpointIdentityRefresh, useFactory: () => new NetworkEndpointIdentityRefresh(refreshLocalNeighborIdentity) },
    DeviceInvestigationWorkflowService,
    DeviceInvestigationHistoryStore,
    PortalDeviceMeasurementsService,
  ],
})
export class PortalModule {}
