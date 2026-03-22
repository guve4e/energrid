import { Injectable, Logger } from '@nestjs/common'
import { appendVoiceTrace } from './utils/voice-trace.util'
import {
  VoiceConversationService,
  VoiceConversationStreamCallbacks,
} from './voice-conversation.service'
import {
  SynthesizedVoiceAudio,
  VoiceSynthesisService,
} from './voice-synthesis.service'

export interface StreamAssistantReplyInput {
  sessionId: string
  conversationId: string
  transcript: string
}

export interface StreamAssistantReplyAudioChunk {
  chunkIndex: number
  isLastChunk: boolean
  text: string
  format: SynthesizedVoiceAudio['format']
  audioBuffer: Buffer
}

export interface StreamAssistantReplyCallbacks {
  onTextDelta: (delta: string, fullText: string) => void
  onAudioChunk: (chunk: StreamAssistantReplyAudioChunk) => void
  onCompleted: (replyText: string) => void
}

interface ReplyStreamState {
  replyText: string
  speakableBuffer: string
  audioChunkIndex: number
}

@Injectable()
export class VoiceAssistantReplyStreamerService {
  private readonly logger = new Logger(VoiceAssistantReplyStreamerService.name)

  private readonly earlyFlushTargetLength = 100
  private readonly minPreferredSplitIndex = 45
  private readonly minFallbackSplitIndex = 35

  constructor(
    private readonly conversationService: VoiceConversationService,
    private readonly synthesisService: VoiceSynthesisService,
  ) {}

  async streamReply(
    input: StreamAssistantReplyInput,
    callbacks: StreamAssistantReplyCallbacks,
  ): Promise<string> {
    const state: ReplyStreamState = {
      replyText: '',
      speakableBuffer: '',
      audioChunkIndex: 0,
    }

    const streamCallbacks: VoiceConversationStreamCallbacks = {
      onTextDelta: async (delta: string) => {
        await this.handleTextDelta(input, state, delta, callbacks)
      },
      onCompletedText: async (fullText: string) => {
        await this.handleCompletedText(input, state, fullText, callbacks)
      },
    }

    const result = await this.conversationService.handleFinalTranscriptStream(
      {
        sessionId: input.sessionId,
        conversationId: input.conversationId,
        transcript: input.transcript,
      },
      streamCallbacks,
    )

    callbacks.onCompleted(result.replyText)

    return result.replyText
  }

  private async handleTextDelta(
    input: StreamAssistantReplyInput,
    state: ReplyStreamState,
    delta: string,
    callbacks: StreamAssistantReplyCallbacks,
  ): Promise<void> {
    if (!delta) return

    state.replyText += delta
    state.speakableBuffer += delta

    appendVoiceTrace({
      type: 'assistant_text_delta',
      sessionId: input.sessionId,
      conversationId: input.conversationId,
      delta,
      accumulatedLength: state.replyText.length,
    })

    callbacks.onTextDelta(delta, state.replyText)

    await this.flushSpeakableChunks(input, state, callbacks, false)
  }

  private async handleCompletedText(
    input: StreamAssistantReplyInput,
    state: ReplyStreamState,
    fullText: string,
    callbacks: StreamAssistantReplyCallbacks,
  ): Promise<void> {
    state.replyText = (fullText || '').trim()
    await this.flushSpeakableChunks(input, state, callbacks, true)
  }

  private async flushSpeakableChunks(
    input: StreamAssistantReplyInput,
    state: ReplyStreamState,
    callbacks: StreamAssistantReplyCallbacks,
    forceFinal: boolean,
  ): Promise<void> {
    while (true) {
      const { chunk, remainder } = this.extractSpeakableChunk(
        state.speakableBuffer,
      )

      if (!chunk) {
        if (forceFinal) {
          await this.flushFinalRemainder(input, state, callbacks)
        }
        return
      }

      state.speakableBuffer = remainder
      const isLastChunk = forceFinal && !state.speakableBuffer.trim()

      await this.emitAudioChunk(
        input,
        state,
        callbacks,
        chunk,
        isLastChunk,
      )
    }
  }

  private async flushFinalRemainder(
    input: StreamAssistantReplyInput,
    state: ReplyStreamState,
    callbacks: StreamAssistantReplyCallbacks,
  ): Promise<void> {
    const finalChunk = state.speakableBuffer.trim()
    if (!finalChunk) return

    state.speakableBuffer = ''

    await this.emitAudioChunk(
      input,
      state,
      callbacks,
      finalChunk,
      true,
    )
  }

  private async emitAudioChunk(
    input: StreamAssistantReplyInput,
    state: ReplyStreamState,
    callbacks: StreamAssistantReplyCallbacks,
    text: string,
    isLastChunk: boolean,
  ): Promise<void> {
    const normalizedText = text.trim()
    if (!normalizedText) return

    const chunkIndex = state.audioChunkIndex++
    const synthStartedAt = Date.now()

    this.logger.log(
      `[ASSISTANT AUDIO CHUNK] session=${input.sessionId} index=${chunkIndex} chars=${normalizedText.length} last=${isLastChunk}`,
    )

    const synthesized = await this.synthesisService.synthesize(normalizedText)
    const synthDurationMs = Date.now() - synthStartedAt

    appendVoiceTrace({
      type: 'assistant_audio_chunk',
      sessionId: input.sessionId,
      conversationId: input.conversationId,
      bytes: synthesized.audioBuffer.length,
      chunkIndex,
      isLastChunk,
      text: normalizedText,
      synthDurationMs,
      assistantAudioAt: Date.now(),
    })

    callbacks.onAudioChunk({
      chunkIndex,
      isLastChunk,
      text: normalizedText,
      format: synthesized.format,
      audioBuffer: synthesized.audioBuffer,
    })
  }

  private extractSpeakableChunk(buffer: string): {
    chunk: string | null
    remainder: string
  } {
    const trimmed = buffer.trimStart()

    if (!trimmed) {
      return { chunk: null, remainder: '' }
    }

    const sentenceChunk = this.extractSentenceChunk(trimmed)
    if (sentenceChunk) {
      return sentenceChunk
    }

    if (!this.shouldForceEarlyFlush(trimmed)) {
      return { chunk: null, remainder: trimmed }
    }

    return this.extractEarlyFlushChunk(trimmed)
  }

  private extractSentenceChunk(text: string): {
    chunk: string
    remainder: string
  } | null {
    const sentenceMatch = text.match(/^(.+?[.!?…]+)(\s+|$)/)

    if (!sentenceMatch) {
      return null
    }

    return {
      chunk: sentenceMatch[1].trim(),
      remainder: text.slice(sentenceMatch[0].length).trimStart(),
    }
  }

  private shouldForceEarlyFlush(text: string): boolean {
    return text.length >= this.earlyFlushTargetLength
  }

  private extractEarlyFlushChunk(text: string): {
    chunk: string | null
    remainder: string
  } {
    const splitAt = this.findPreferredSplitIndex(text)

    return {
      chunk: text.slice(0, splitAt).trim(),
      remainder: text.slice(splitAt).trimStart(),
    }
  }

  private findPreferredSplitIndex(text: string): number {
    let splitAt = this.findSplitAtPunctuation(text)

    if (splitAt >= this.minPreferredSplitIndex) {
      return splitAt
    }

    splitAt = this.findSplitAtWhitespace(text)

    if (splitAt >= this.minFallbackSplitIndex) {
      return splitAt
    }

    return this.earlyFlushTargetLength
  }

  private findSplitAtPunctuation(text: string): number {
    const punctuationCandidates = [',', ';', ':']

    for (const mark of punctuationCandidates) {
      const index = text.lastIndexOf(mark, this.earlyFlushTargetLength)
      if (index >= 0) {
        return index
      }
    }

    return -1
  }

  private findSplitAtWhitespace(text: string): number {
    return text.lastIndexOf(' ', this.earlyFlushTargetLength)
  }
}
