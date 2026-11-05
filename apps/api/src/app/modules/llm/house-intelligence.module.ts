import { Module } from '@nestjs/common';
import { HOUSE_AGENT } from './house-agent.port';
import { LettaHouseAgentAdapter } from './letta-house-agent.adapter';
import { DevicesModule } from '../devices/devices.module';
import { PersonalExpensesModule } from '../expenses/personal-expenses.module';
import { FinanceAssistantTools } from './finance-assistant-tools';
import { WeatherAssistantTools } from './weather-assistant-tools';

@Module({
  imports: [DevicesModule, PersonalExpensesModule],
  providers: [
    LettaHouseAgentAdapter,
    FinanceAssistantTools,
    WeatherAssistantTools,
    { provide: HOUSE_AGENT, useExisting: LettaHouseAgentAdapter },
  ],
  exports: [HOUSE_AGENT],
})
export class HouseIntelligenceModule {}
