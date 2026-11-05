import { Injectable, Logger } from '@nestjs/common';
import { AppdDanubeProviderService } from './appd-danube-provider.service';
import { DanubePortalProviderService } from './danube-portal-provider.service';
import { RiverHistoryService } from './river-history.service';

@Injectable()
export class RiverCollectorService {
  private readonly logger = new Logger(RiverCollectorService.name);

  constructor(
    private readonly appd: AppdDanubeProviderService,
    private readonly danubePortal: DanubePortalProviderService,
    private readonly history: RiverHistoryService,
  ) {}

  async collectNow() {
    const appdStations = await this.appd.getStations();
    const portalStations = await this.danubePortal.getStations();

    const allStations = [...appdStations, ...portalStations];

    const saved = await this.history.saveReadings(allStations);

    this.logger.log(
      `River source readings=${allStations.length}, stored=${saved.processed}, ` +
      `without verified measurement time=${saved.skippedUnverified}`,
    );

    return {
      fetched: allStations.length,
      processed: saved.processed,
      skippedUnverified: saved.skippedUnverified,
      providers: {
        appd: appdStations.length,
        danubePortal: portalStations.length,
      },
      stations: allStations.map((s) => `${s.provider}:${s.station}`),
    };
  }
}
