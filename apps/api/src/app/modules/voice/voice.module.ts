import { Module } from '@nestjs/common'
import { VoiceGateway } from './voice.gateway'
import { DebugGateway } from './debug.gateway'
import { DebugEventsService } from './debug-events.service'
import { VoiceSttService } from './voice-stt.service'
import { VoiceSessionService } from './voice-session.service'
import { VoiceConversationService } from './voice-conversation.service'
import { VoiceSynthesisService } from './voice-synthesis.service'
import { VoiceAssistantReplyStreamerService } from './voice-assistant-reply-streamer.service'

@Module({
  providers: [
    VoiceGateway,
    DebugGateway,
    DebugEventsService,
    VoiceSttService,
    VoiceSessionService,
    VoiceConversationService,
    VoiceSynthesisService,
    VoiceAssistantReplyStreamerService,
  ],
})
export class VoiceModule {}
