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
import { VoiceRunStoreService } from './voice-run-store.service'
import { VoiceProtocolController } from './voice-protocol.controller'
import { VoiceClientController } from './voice-client.controller'
import { HomeAutomationService } from './home-automation.service'
import { DevicesModule } from '../devices/devices.module'
import { LocalWhisperSttProvider } from './local-whisper-stt.provider'
import {
  OpenAiBatchSttProvider,
  OpenAiSpeechSynthesisProvider,
} from './openai-speech.providers'
import { OpenAiConversationModelProvider } from './openai-conversation-model.provider'
import { createOpenAIStreamingSttProvider } from '@energrid/stt-stream-openai'
import {
  CONVERSATION_MODEL_PROVIDER,
  SPEECH_SYNTHESIS_PROVIDER,
  SPEECH_TO_TEXT_PROVIDERS,
  STREAMING_STT_PROVIDERS,
} from './speech-provider.tokens'

@Module({
  imports: [DevicesModule],
  controllers: [VoiceProtocolController, VoiceClientController],
  providers: [
    VoiceGateway,
    DebugGateway,
    DebugEventsService,
    VoiceSttService,
    LocalWhisperSttProvider,
    OpenAiBatchSttProvider,
    OpenAiSpeechSynthesisProvider,
    OpenAiConversationModelProvider,
    {
      provide: SPEECH_TO_TEXT_PROVIDERS,
      useFactory: (
        openai: OpenAiBatchSttProvider,
        local: LocalWhisperSttProvider,
      ) => [openai, local],
      inject: [OpenAiBatchSttProvider, LocalWhisperSttProvider],
    },
    {
      provide: STREAMING_STT_PROVIDERS,
      useFactory: () => [createOpenAIStreamingSttProvider()],
    },
    {
      provide: SPEECH_SYNTHESIS_PROVIDER,
      useExisting: OpenAiSpeechSynthesisProvider,
    },
    {
      provide: CONVERSATION_MODEL_PROVIDER,
      useExisting: OpenAiConversationModelProvider,
    },
    VoiceSessionService,
    VoiceConversationService,
    VoiceSynthesisService,
    VoiceAssistantReplyStreamerService,
    VoiceSessionTraceService,
    VoiceSessionEmitterService,
    VoiceRunStoreService,
    HomeAutomationService,
  ],
})
export class VoiceModule {}
