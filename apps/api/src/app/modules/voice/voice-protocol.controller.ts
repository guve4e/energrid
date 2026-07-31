import { Controller, Get } from '@nestjs/common'
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger'

@ApiTags('voice')
@Controller('voice')
export class VoiceProtocolController {
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
      localWhisperModel:
        process.env.LOCAL_WHISPER_MODEL_PATH ||
        process.env.LOCAL_WHISPER_MODEL ||
        'small',
      localWhisperLanguage: process.env.LOCAL_WHISPER_LANGUAGE || 'bg',
    }
  }
}
