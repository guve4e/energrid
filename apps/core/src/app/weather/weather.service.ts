import { compareWeather } from './weather-comparison';
import { Injectable, Logger } from '@nestjs/common';
import { WeatherProviderService } from './weather-provider.service';
import { WeatherRiskEngine } from './weather-risk.engine';
import { DanubeProviderService } from './danube-provider.service';
import { WeatherIntelligenceService } from './weather-intelligence.service';

@Injectable()
export class WeatherService {
  private readonly logger = new Logger(WeatherService.name);
  constructor(
    private readonly provider: WeatherProviderService,
    private readonly riskEngine: WeatherRiskEngine,
    private readonly danubeProvider: DanubeProviderService,
    private readonly intelligenceService: WeatherIntelligenceService,
  ) {}

  async getDashboard() {
    const [snapshots, river] = await Promise.all([
      Promise.all([this.provider.getSnapshot('icon_seamless'), this.provider.getSnapshot('ncep_gfs_seamless')]),
      this.danubeProvider.getVidinRiverData().catch(() => {
        this.logger.warn('River data unavailable; continuing weather assessment without river data');
        return null;
      }),
    ]);
    const { selected, comparison } = compareWeather(snapshots, river, this.riskEngine, this.intelligenceService);
    const intelligence = { ...selected.intelligence,
      confidence: comparison.usableModels < 2 ? selected.intelligence.confidence :
        comparison.status === 'disagreement' ? 'models-disagree' : 'models-agree-unvalidated',
    };
    const riskReport = selected.risk.level === 'unknown' ? selected.risk : {
      ...selected.risk,
      level: intelligence.severity === 'danger' ? 'high' :
        intelligence.severity === 'watch' ? 'medium' : selected.risk.level,
    };
    return { ...selected.snapshot, river, riskReport, intelligence, comparison,
      dataQuality: selected.quality, summary: intelligence.subtitle };
  }
}
