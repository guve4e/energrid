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

    await this.history.saveReadings(allStations);

    this.logger.log(
      `Processed ${allStations.length} river readings: APPD=${appdStations.length}, DanubePortal=${portalStations.length}`,
    );

    return {
      processed: allStations.length,
      providers: {
        appd: appdStations.length,
        danubePortal: portalStations.length,
      },
      stations: allStations.map((s) => `${s.provider}:${s.station}`),
    };
  }
}
