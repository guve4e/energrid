import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';

import { RiverForecastRecorderService } from './forecast-monitoring/river-forecast-recorder.service';
import { RiverCollectorService } from './river-collector.service';
import { RiverService } from './river.service';

@Injectable()
export class RiverSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RiverSchedulerService.name);

  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly collector: RiverCollectorService,

    private readonly riverService: RiverService,

    private readonly forecastRecorder: RiverForecastRecorderService,
  ) {}

  onModuleInit() {
    const enabled =
      String(process.env.RIVER_COLLECTOR_ENABLED ?? 'true').toLowerCase() ===
      'true';

    if (!enabled) {
      this.logger.log('River collector scheduler disabled');

      return;
    }

    this.logger.log('River collector scheduler enabled: every 60 minutes');

    void this.collectForecastAndEvaluateSafe();

    this.timer = setInterval(
      () => {
        void this.collectForecastAndEvaluateSafe();
      },
      60 * 60 * 1000,
    );
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async collectForecastAndEvaluateSafe() {
    try {
      const collection = await this.collector.collectNow();

      this.logger.log(
        `River collection complete: ${JSON.stringify(collection)}`,
      );

      const dashboard = await this.riverService.getDanubeDashboard();

      const forecastRecording =
        await this.forecastRecorder.recordDashboardForecasts(dashboard);

      this.logger.log(
        `River forecast recording complete: ${JSON.stringify(
          forecastRecording,
        )}`,
      );
    } catch (error) {
      this.logger.warn(
        `River collection/forecast cycle failed: ${String(error)}`,
      );
    }
  }
}
