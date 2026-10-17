import { Module } from '@nestjs/common';
import { EnergyModule } from './modules/energy/energy.module';

@Module({
  imports: [EnergyModule],
})
export class HistoryOnlyModule {}
