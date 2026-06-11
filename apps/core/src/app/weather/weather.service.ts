import { Injectable } from '@nestjs/common';
import { WeatherProviderService } from './weather-provider.service';
import { WeatherRiskEngine } from './weather-risk.engine';
import { DanubeProviderService } from './danube-provider.service';
import { WeatherIntelligenceService } from './weather-intelligence.service';

@Injectable()
export class WeatherService {
  constructor(
    private readonly provider: WeatherProviderService,
    private readonly riskEngine: WeatherRiskEngine,
    private readonly danubeProvider: DanubeProviderService,
    private readonly intelligenceService: WeatherIntelligenceService,
  ) {}

  async getDashboard() {
    const snapshot = await this.provider.getSnapshot();
    const river = await this.danubeProvider.getVidinRiverData();
    const riskReport = this.riskEngine.evaluate(snapshot);
    const intelligence = this.intelligenceService.analyze(snapshot, river, riskReport);

    return {
      ...snapshot,
      river,
      riskReport,
      intelligence,
      summary: intelligence.subtitle,
    };
  }
}
