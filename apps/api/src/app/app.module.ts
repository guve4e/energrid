import { Module } from '@nestjs/common';
import { AuthModule } from './modules/auth/auth.module';
import { VoiceModule } from './modules/voice/voice.module';

@Module({
  imports: [AuthModule, VoiceModule],
})
export class AppModule {}
