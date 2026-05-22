import { Injectable } from '@nestjs/common';
import { WeatherProviderService } from './weather-provider.service';
import { WeatherRiskEngine } from './weather-risk.engine';
import { DanubeProviderService } from './danube-provider.service';

@Injectable()
export class WeatherService {
  constructor(
    private readonly provider: WeatherProviderService,
    private readonly riskEngine: WeatherRiskEngine,
    private readonly danubeProvider: DanubeProviderService,
  ) {}

  async getDashboard() {
    const snapshot = await this.provider.getSnapshot();
    const river = await this.danubeProvider.getVidinRiverData();
    const riskReport = this.riskEngine.evaluate(snapshot);

    return {
      ...snapshot,
      river,
      riskReport,
      summary:
        riskReport.level === 'high'
          ? 'Weather risks detected. Review wind and storm conditions.'
          : 'No major risks detected.',
    };
  }
}
