import { Injectable, Logger } from '@nestjs/common';
import { AppdDanubeProviderService } from './appd-danube-provider.service';
import { DanubePortalProviderService } from './danube-portal-provider.service';
import { RiverHistoryService } from './river-history.service';
import { RiverSourceObservationStore } from './river-source-observation.store';

@Injectable()
export class RiverCollectorService {
  private readonly logger = new Logger(RiverCollectorService.name);

  constructor(
    private readonly appd: AppdDanubeProviderService,
    private readonly danubePortal: DanubePortalProviderService,
    private readonly history: RiverHistoryService,
    private readonly sourceObservations: RiverSourceObservationStore,
  ) {}

  async collectNow() {
    const appdStations = await this.appd.getStations();
    const portalStations = await this.danubePortal.getStations();

    const allStations = [...appdStations, ...portalStations];

    // Opt in after the source-evidence migration is verified on this database.
    const sourceEvidence = process.env.RIVER_SOURCE_EVIDENCE_ENABLED === 'true'
      ? await this.sourceObservations.record(allStations)
      : { status: 'disabled' as const };
    const saved = await this.history.saveReadings(allStations);

    this.logger.log(
      `River source readings=${allStations.length}, stored=${saved.processed}, ` +
      `without verified measurement time=${saved.skippedUnverified}`,
    );

    return {
      fetched: allStations.length,
      processed: saved.processed,
      skippedUnverified: saved.skippedUnverified,
      sourceEvidence,
      providers: {
        appd: appdStations.length,
        danubePortal: portalStations.length,
      },
      stations: allStations.map((s) => `${s.provider}:${s.station}`),
    };
  }
}
