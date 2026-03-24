import { Module } from '@nestjs/common';
import { PanelModule } from './modules/panel/panel.module';
import { AuthModule } from './modules/auth/auth.module';
import { VoiceModule } from './modules/voice/voice.module';

@Module({
  imports: [PanelModule, AuthModule, VoiceModule],
})
export class AppModule {}
