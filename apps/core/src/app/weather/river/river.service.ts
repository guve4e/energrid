import { Injectable } from '@nestjs/common';
import { AppdDanubeProviderService } from './appd-danube-provider.service';
import { DanubePortalProviderService } from './danube-portal-provider.service';
import { RiverIntelligenceService } from './river-intelligence.service';
import { RiverHistoryService } from './river-history.service';
import { RiverStationNormalizerService } from './river-station-normalizer.service';

@Injectable()
export class RiverService {
  constructor(
    private readonly appd: AppdDanubeProviderService,
    private readonly danubePortal: DanubePortalProviderService,
    private readonly intelligence: RiverIntelligenceService,
    private readonly history: RiverHistoryService,
    private readonly normalizer: RiverStationNormalizerService,
  ) {}

  async getDanubeDashboard() {
    const appdStations = await this.appd.getStations();
    const portalStations = await this.danubePortal.getStations();

    const stations = [...appdStations, ...portalStations];

    const mainStation =
      appdStations.find((s) => s.station === 'Vidin') ??
      stations.find((s) => s.station.toLowerCase().includes('vidin')) ??
      null;

    const normalizedStations = this.normalizer.normalize(stations);

    const history = mainStation
      ? await this.history.getRecent(mainStation.station, 24)
      : [];

    const historyTrend = mainStation
      ? await this.history.getTrendSummary(mainStation.station)
      : null;

    const dashboard = this.intelligence.analyze(
      mainStation,
      normalizedStations,
      historyTrend,
    );

    return {
      ...dashboard,
      providers: {
        appd: appdStations.length,
        danubePortal: portalStations.length,
      },
      normalizedStations,
      history,
    };
  }
}
