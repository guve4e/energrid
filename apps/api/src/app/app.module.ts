import { Module } from '@nestjs/common';
import { PanelModule } from './modules/panel/panel.module';
import { AuthModule } from './modules/auth/auth.module';
import { VoiceModule } from './modules/voice/voice.module';
import { PortalModule } from './modules/portal/portal.module';
import { EnergyModule } from './modules/energy/energy.module';
import { PersonalExpensesModule } from './modules/expenses/personal-expenses.module';

@Module({
  imports: [
    PanelModule,
    AuthModule,
    VoiceModule,
    PortalModule,
    EnergyModule,
    PersonalExpensesModule,
  ],
})
export class AppModule {}
