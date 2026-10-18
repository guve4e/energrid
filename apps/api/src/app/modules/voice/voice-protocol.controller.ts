import { Controller, Get, Query, Req } from '@nestjs/common'
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger'
import { VoiceRunStoreService } from './voice-run-store.service'
import { assertVoiceAuthorization } from './voice-auth'

@ApiTags('voice')
@Controller('voice')
export class VoiceProtocolController {
  constructor(private readonly runStore: VoiceRunStoreService) {}

  @Get('protocol')
  @ApiOperation({ summary: 'Describe the voice WebSocket protocol' })
  @ApiOkResponse({
    schema: {
      example: {
        websocketPath: '/voice',
        inputAudio: {
          transport: 'binary WebSocket messages',
          format: 'PCM16',
          sampleRateHz: 16000,
          channels: 1,
          chunkSamples: 4096,
        },
        clientMessages: [
          {
            type: 'authenticate',
            description: 'First message; contains the portal control token.',
          },
          {
            type: 'end_of_turn',
            description: 'Sent as JSON text after VAD detects user silence.',
          },
          {
            type: 'confirm_action',
            description: 'Confirm a pending action using its one-time approvalId.',
          },
          {
            type: 'cancel_action',
            description: 'Cancel a pending action using its one-time approvalId.',
          },
        ],
        serverEvents: [
          'session_start',
          'stt_partial',
          'stt_final',
          'assistant_text_delta',
          'assistant_audio_chunk',
          'assistant_final',
          'action_confirmation_required',
          'action_confirmation_result',
          'turn_end',
          'error',
        ],
      },
    },
  })
  getProtocol() {
    return {
      websocketPath: '/voice',
      inputAudio: {
        transport: 'binary WebSocket messages',
        format: 'PCM16',
        sampleRateHz: 16000,
        channels: 1,
        chunkSamples: 4096,
      },
      clientMessages: [
        {
          type: 'authenticate',
          description: 'First message; contains the portal control token.',
          example: { type: 'authenticate', token: '<PORTAL_CONTROL_TOKEN>' },
        },
        {
          type: 'end_of_turn',
          description: 'Sent as JSON text after VAD detects user silence.',
          example: { type: 'end_of_turn' },
        },
        {
          type: 'confirm_action',
          description: 'Confirm a pending action using its one-time approvalId.',
          example: { type: 'confirm_action', approvalId: '<approval-id>' },
        },
        {
          type: 'cancel_action',
          description: 'Cancel a pending action using its one-time approvalId.',
          example: { type: 'cancel_action', approvalId: '<approval-id>' },
        },
      ],
      serverEvents: [
        'session_start',
        'stt_partial',
        'stt_final',
        'assistant_text_delta',
        'assistant_audio_chunk',
        'assistant_final',
        'action_confirmation_required',
        'action_confirmation_result',
        'turn_end',
        'error',
      ],
      replayCommand: 'pnpm voice:replay /path/to/test.wav',
    }
  }

  @Get('config')
  @ApiOperation({ summary: 'Show active voice runtime configuration' })
  @ApiOkResponse({
    schema: {
      example: {
        sttProvider: 'openai',
        openaiBatchModel: 'gpt-4o-transcribe',
        localWhisperFallbackToOpenAI: false,
        localWhisperWorker: true,
        localWhisperModel: 'small',
        localWhisperLanguage: 'bg',
      },
    },
  })
  getConfig() {
    return {
      sttProvider: process.env.VOICE_STT_PROVIDER || process.env.STT_PROVIDER || 'openai',
      sttMode: process.env.VOICE_STT_MODE || 'buffered',
      streamingSttProvider: process.env.VOICE_STT_STREAM_PROVIDER || 'openai',
      streamingSttModel: process.env.OPENAI_STT_STREAM_MODEL || 'gpt-live-transcribe',
      voiceAudioSampleRateHz: Number(process.env.VOICE_AUDIO_SAMPLE_RATE_HZ) || 16_000,
      streamingSttConnectTimeoutMs: boundedTimeout(
        process.env.OPENAI_STT_STREAM_CONNECT_TIMEOUT_MS || '10000',
      ),
      openaiBatchModel: process.env.BATCH_STT_MODEL || 'gpt-4o-transcribe',
      sttTimeoutMs: boundedTimeout(process.env.VOICE_STT_TIMEOUT_MS),
      conversationProvider: 'openai',
      conversationModel: process.env.VOICE_CHAT_MODEL || 'gpt-4o-mini',
      conversationTimeoutMs: boundedTimeout(process.env.VOICE_CHAT_TIMEOUT_MS),
      ttsProvider: 'openai',
      ttsModel: process.env.VOICE_TTS_MODEL || 'gpt-4o-mini-tts',
      ttsVoice: process.env.VOICE_TTS_VOICE || 'alloy',
      ttsLanguage: process.env.VOICE_TTS_LANGUAGE || 'bg',
      ttsTimeoutMs: boundedTimeout(process.env.VOICE_TTS_TIMEOUT_MS),
      localWhisperFallbackToOpenAI:
        process.env.LOCAL_WHISPER_FALLBACK_TO_OPENAI === 'true',
      localWhisperWorker: process.env.LOCAL_WHISPER_WORKER !== 'false',
      localWhisperModel:
        process.env.LOCAL_WHISPER_MODEL_PATH ||
        process.env.LOCAL_WHISPER_MODEL ||
        'small',
      localWhisperLanguage: process.env.LOCAL_WHISPER_LANGUAGE || 'bg',
    }
  }

  @Get('runs')
  @ApiOperation({ summary: 'List recent persisted voice assistant runs' })
  @ApiOkResponse({
    schema: {
      example: {
        storage: {
          enabled: true,
          file: '/var/www/energrid/data/voice-runs.jsonl',
        },
        runs: [
          {
            id: 'session-id:1785600000000',
            type: 'voice_turn',
            transcript: 'Включи лампите в банята.',
            intent: 'turn_on_lights',
            metrics: { totalMs: 3200, sttMs: 900 },
          },
        ],
      },
    },
  })
  getRuns(
    @Query('limit') limit: string | undefined,
    @Req() request: { headers: { authorization?: string | string[] } },
  ) {
    assertVoiceAuthorization(request)
    const parsedLimit = Number(limit)

    return {
      storage: this.runStore.getInfo(),
      runs: this.runStore.listRecent(
        Number.isFinite(parsedLimit) ? parsedLimit : 50,
      ),
    }
  }
}

function boundedTimeout(value: string | undefined): number {
  const configured = Number(value)
  if (!Number.isFinite(configured)) return 30_000
  return Math.max(1_000, Math.min(120_000, Math.floor(configured)))
}
