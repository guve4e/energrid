import { Injectable } from '@nestjs/common';

import { AppdDanubeProviderService } from './appd-danube-provider.service';
import { DanubePortalProviderService } from './danube-portal-provider.service';
import { RiverForecastService } from './forecast/river-forecast.service';
import { RiverHistoryService } from './river-history.service';
import { RiverIntelligenceService } from './river-intelligence.service';
import { RiverStationNormalizerService } from './river-station-normalizer.service';
import { TravelTimeEngine } from './engines/travel-time.engine';
import { DailyPropagationEngine } from './engines/propagation/daily-propagation.engine';
import { NOVO_SELO_TO_LOM_DAILY_MODEL } from './engines/propagation/validated-propagation.models';

@Injectable()
export class RiverService {
  private readonly dailyPropagation =
    new DailyPropagationEngine();
  constructor(
    private readonly appd: AppdDanubeProviderService,
    private readonly danubePortal: DanubePortalProviderService,
    private readonly intelligence: RiverIntelligenceService,
    private readonly history: RiverHistoryService,
    private readonly normalizer: RiverStationNormalizerService,
    private readonly riverForecast: RiverForecastService,
    private readonly travelTime: TravelTimeEngine,
  ) {}

  async getDanubeDashboard() {
    const [appdStations, portalStations] = await Promise.all([
      this.appd.getStations(),
      this.danubePortal.getStations(),
    ]);

    const stations = [
      ...appdStations,
      ...portalStations,
    ];

    const mainStation =
      appdStations.find(
        (station) => station.station === 'Vidin',
      ) ??
      stations.find((station) =>
        station.station
          .toLowerCase()
          .includes('vidin'),
      ) ??
      null;

    const normalizedStations =
      this.normalizer.normalize(stations);

    const novoSeloLive =
      normalizedStations.find(
        (station) => station.key === 'novo-selo',
      )?.bestReading ?? null;

    const lomLive =
      normalizedStations.find(
        (station) => station.key === 'lom',
      )?.bestReading ?? null;

    const propagation = this.travelTime.find(
      'novo-selo',
      'vidin',
    );

    const delayedNovoSelo =
      propagation
        ? await this.history.getReadingClosestTo(
            'Novo Selo',
            new Date(
              Date.now() -
                propagation.averageHours * 3600000,
            ),
          )
        : null;

    const [history, historyTrend] = mainStation
      ? await Promise.all([
          this.history.getRecent(
            mainStation.station,
            24,
          ),
          this.history.getTrendSummary(
            mainStation.station,
          ),
        ])
      : [[], null];

    const regionalPropagationForecast =
      novoSeloLive?.difference24hCm != null &&
      lomLive?.difference24hCm != null
        ? this.dailyPropagation.predict(
            NOVO_SELO_TO_LOM_DAILY_MODEL,
            {
              upstreamDelta24hCm:
                Number(
                  novoSeloLive
                    .difference24hCm,
                ),

              downstreamDelta24hCm:
                Number(
                  lomLive
                    .difference24hCm,
                ),

              downstreamCurrentLevelCm:
                lomLive.levelCm == null
                  ? null
                  : Number(
                      lomLive.levelCm,
                    ),
            },
          )
        : null;

    const forecastResult =
      mainStation &&
      mainStation.levelCm != null &&
      history.length >= 2
        ? await this.riverForecast.generate({
            station: mainStation.station,
            currentCm: Number(mainStation.levelCm),
            history,
            change24hCm:
              mainStation.difference24hCm == null
                ? null
                : Number(
                    mainStation.difference24hCm,
                  ),
            upstreamTrend:
              delayedNovoSelo?.trend ??
              novoSeloLive?.trend,
            upstreamDischarge:
              delayedNovoSelo?.dischargeM3s ??
              novoSeloLive?.dischargeM3s ??
              null,
            downstreamTrend:
              lomLive?.trend,
            upstreamAnalogue:
              delayedNovoSelo?.levelCm != null
                ? {
                    stationCode: 'novo-selo',
                    levelCm: Number(
                      delayedNovoSelo.levelCm,
                    ),
                    change24hCm: Number(
                      delayedNovoSelo
                        .difference24hCm ?? 0,
                    ),
                    dischargeM3s:
                      delayedNovoSelo
                        .dischargeM3s ?? null,
                    waterTemperatureC:
                      delayedNovoSelo
                        .waterTempC ?? null,
                  }
                : null,
          })
        : {
            forecast: null,
            analogues: null,
            confidence: null,
          };

    const dashboard =
      this.intelligence.analyze(
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
      forecast: forecastResult.forecast,
      analogues: forecastResult.analogues,
      confidence: forecastResult.confidence,

      regionalPropagationForecast,

      propagation: propagation
        ? {
            upstreamStation: 'Novo Selo',
            downstreamStation: 'Vidin',
            assumedDelayHours:
              propagation.averageHours,
            confidence:
              propagation.confidence,
            referenceReadingAt:
              delayedNovoSelo?.fetchedAt ?? null,
          }
        : null,
    };
  }
}
