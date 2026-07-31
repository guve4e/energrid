import { Module } from '@nestjs/common'
import { VoiceGateway } from './voice.gateway'
import { DebugGateway } from './debug.gateway'
import { DebugEventsService } from './debug-events.service'
import { VoiceSttService } from './voice-stt.service'
import { VoiceSessionService } from './voice-session.service'
import { VoiceConversationService } from './voice-conversation.service'
import { VoiceSynthesisService } from './voice-synthesis.service'
import { VoiceAssistantReplyStreamerService } from './voice-assistant-reply-streamer.service'
import { VoiceSessionTraceService } from './voice-session-trace.service'
import { VoiceSessionEmitterService } from './voice-session-emitter.service'
import { VoiceProtocolController } from './voice-protocol.controller'
import { VoiceClientController } from './voice-client.controller'

@Module({
  controllers: [VoiceProtocolController, VoiceClientController],
  providers: [
    VoiceGateway,
    DebugGateway,
    DebugEventsService,
    VoiceSttService,
    VoiceSessionService,
    VoiceConversationService,
    VoiceSynthesisService,
    VoiceAssistantReplyStreamerService,
    VoiceSessionTraceService,
    VoiceSessionEmitterService
  ],
})
export class VoiceModule {}
