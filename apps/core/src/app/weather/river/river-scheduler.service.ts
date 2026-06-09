import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { RiverCollectorService } from './river-collector.service';

@Injectable()
export class RiverSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(RiverSchedulerService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly collector: RiverCollectorService) {}

  onModuleInit() {
    const enabled = String(process.env.RIVER_COLLECTOR_ENABLED || 'true').toLowerCase() === 'true';

    if (!enabled) {
      this.logger.log('River collector scheduler disabled');
      return;
    }

    this.logger.log('River collector scheduler enabled: every 60 minutes');

    this.collectSafe();

    this.timer = setInterval(() => {
      this.collectSafe();
    }, 60 * 60 * 1000);
  }

  private async collectSafe() {
    try {
      const result = await this.collector.collectNow();
      this.logger.log(`River collection complete: ${JSON.stringify(result)}`);
    } catch (error) {
      this.logger.warn(`River collection failed: ${String(error)}`);
    }
  }
}
