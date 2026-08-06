import { Controller, Get, Query } from '@nestjs/common'
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger'
import { VoiceRunStoreService } from './voice-run-store.service'

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
            type: 'end_of_turn',
            description: 'Sent as JSON text after VAD detects user silence.',
          },
        ],
        serverEvents: [
          'session_start',
          'stt_partial',
          'stt_final',
          'assistant_text_delta',
          'assistant_audio_chunk',
          'assistant_final',
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
          type: 'end_of_turn',
          description: 'Sent as JSON text after VAD detects user silence.',
          example: { type: 'end_of_turn' },
        },
      ],
      serverEvents: [
        'session_start',
        'stt_partial',
        'stt_final',
        'assistant_text_delta',
        'assistant_audio_chunk',
        'assistant_final',
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
      openaiBatchModel: process.env.BATCH_STT_MODEL || 'gpt-4o-transcribe',
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
  getRuns(@Query('limit') limit?: string) {
    const parsedLimit = Number(limit)

    return {
      storage: this.runStore.getInfo(),
      runs: this.runStore.listRecent(
        Number.isFinite(parsedLimit) ? parsedLimit : 50,
      ),
    }
  }
}
