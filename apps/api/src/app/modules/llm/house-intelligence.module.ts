import { Module } from '@nestjs/common';
import { HOUSE_AGENT } from './house-agent.port';
import { LettaHouseAgentAdapter } from './letta-house-agent.adapter';
import { DevicesModule } from '../devices/devices.module';

@Module({
  imports: [DevicesModule],
  providers: [
    LettaHouseAgentAdapter,
    { provide: HOUSE_AGENT, useExisting: LettaHouseAgentAdapter },
  ],
  exports: [HOUSE_AGENT],
})
export class HouseIntelligenceModule {}
