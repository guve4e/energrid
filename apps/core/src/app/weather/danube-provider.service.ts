import { Injectable } from '@nestjs/common';
import { RiverService } from './river/river.service';

@Injectable()
export class DanubeProviderService {
  constructor(private readonly riverService: RiverService) {}

  async getVidinRiverData() {
    const dashboard = await this.riverService.getDanubeDashboard();
    const main = dashboard.mainStation;

    if (!main) return null;

    return {
      station: main.station,
      elevationM: main.elevationM,
      levelCm: main.levelCm,
      dischargeM3s: main.dischargeM3s,
      difference24hCm: main.difference24hCm,
      trend: main.trend,
      waterTempC: main.waterTempC,
      provider: main.provider,
      fetchedAt: main.fetchedAt,
      intelligence: dashboard.intelligence,
      nearbyStations: dashboard.nearbyStations,
      normalizedStations: dashboard.normalizedStations,
      providers: dashboard.providers,
      history: dashboard.history,
    };
  }
}
