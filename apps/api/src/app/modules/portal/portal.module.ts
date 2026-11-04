import { HouseIntelligenceModule } from '../llm/house-intelligence.module'
import { Module } from '@nestjs/common'
import { APP_INTERCEPTOR } from '@nestjs/core'
import { LlmGatewayService, OpenAiDeviceLlmProvider } from '../llm/llm-gateway.service'
import { DeviceAiInvestigationService } from '../llm/device-ai-investigation.service'
import { NetworkEndpointInvestigatorService } from '../llm/network-endpoint-investigator.service'
import { DeviceInvestigationWorkflowService } from '../llm/device-investigation-workflow.service'
import { ReadOnlyHttpIdentityProbe } from '../llm/read-only-http-identity-probe'
import { NetworkEndpointIdentityRefresh } from '../llm/network-endpoint-identity-refresh'
import { refreshLocalNeighborIdentity } from '../devices/adapters/outbound/network/targeted-neighbor-identity.adapter'
import { DeviceInvestigationHistoryStore } from '../llm/device-investigation-history.store'
import { PortalController } from './portal.controller'
import { PortalDeviceTelemetryController } from './portal-device-telemetry.controller'
import { PortalMqttDiagnosticsController } from './portal-mqtt-diagnostics.controller'
import { PortalNetworkDiscoveryReadController } from './portal-network-discovery-read.controller'
import { PortalNetworkDiscoveryScanController } from './portal-network-discovery-scan.controller'
import { PortalSiteLocalShellyEvidenceController } from './portal-site-local-shelly-evidence.controller'
import { PortalSnapshotEndpointInvestigationController } from './portal-snapshot-endpoint-investigation.controller'
import { PortalSiteLocalShellyEvidenceWorkflow } from './portal-site-local-shelly-evidence.workflow'
import { PortalDeviceProxyService } from './portal-device-proxy.service'
import { PortalStateService } from './portal-state.service'
import { DeviceOnboardingService } from './device-onboarding.service'
import { DevicesModule } from '../devices/devices.module'
import { DeviceEnrollmentModule } from '../devices/enrollment/device-enrollment.module'
import { PortalWeatherController } from './portal-weather.controller'
import { PortalDeviceMeasurementsService } from './portal-device-measurements.service'
import { PortalDeviceElectricalMeasurementsService } from './portal-device-electrical-measurements.service'
import { TelemetryModule } from '../telemetry/telemetry.module'
import { WeatherAssistantQueryService } from './weather-assistant-query.service'
import { WeatherInferenceController } from './weather-inference.controller'
import { WeatherInferenceService } from './weather-inference.service'
import { PortalSiteService } from './portal-site.service'
import { PortalSiteContextInterceptor } from './portal-site-context.interceptor'

@Module({
  imports: [DevicesModule, DeviceEnrollmentModule, HouseIntelligenceModule, TelemetryModule],
  controllers: [PortalController, PortalDeviceTelemetryController, PortalMqttDiagnosticsController, PortalNetworkDiscoveryReadController, PortalNetworkDiscoveryScanController, PortalSiteLocalShellyEvidenceController, PortalSnapshotEndpointInvestigationController, PortalWeatherController, WeatherInferenceController],
  providers: [
    PortalSiteLocalShellyEvidenceWorkflow,
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
    PortalDeviceElectricalMeasurementsService,
    WeatherAssistantQueryService,
    WeatherInferenceService,
    PortalSiteService,
    { provide: APP_INTERCEPTOR, useClass: PortalSiteContextInterceptor },
  ],
})
export class PortalModule {}
