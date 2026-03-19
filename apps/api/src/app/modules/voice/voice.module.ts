import { Module } from '@nestjs/common'
import { VoiceGateway } from './voice.gateway'
import { DebugGateway } from './debug.gateway'
import { DebugEventsService } from './debug-events.service'
import { VoiceSttService } from './voice-stt.service'

@Module({
  providers: [VoiceGateway, DebugGateway, DebugEventsService, VoiceSttService],
})
export class VoiceModule {}
