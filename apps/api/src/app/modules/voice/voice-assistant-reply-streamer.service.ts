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
  onMetrics?: (metrics: Record<string, number>) => void
}

interface ReplyStreamState {
  replyText: string
  speakableBuffer: string
  audioChunkIndex: number
}

@Injectable()
export class VoiceAssistantReplyStreamerService {
  private readonly logger = new Logger(VoiceAssistantReplyStreamerService.name)

  private readonly earlyFlushTargetLength = 70
  private readonly minPreferredSplitIndex = 28
  private readonly minFallbackSplitIndex = 24

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
      onMetrics: async (metrics) => {
        callbacks.onMetrics?.(this.normalizeConversationMetrics(metrics))
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

  async streamStaticReply(
    input: StreamAssistantReplyInput & { replyText: string },
    callbacks: StreamAssistantReplyCallbacks,
  ): Promise<string> {
    const state: ReplyStreamState = {
      replyText: '',
      speakableBuffer: '',
      audioChunkIndex: 0,
    }

    await this.handleTextDelta(input, state, input.replyText, callbacks)
    await this.handleCompletedText(input, state, input.replyText, callbacks)

    callbacks.onCompleted(input.replyText)

    return input.replyText
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

      const isLastChunk = forceFinal && !this.hasPendingSpeakableText(state)
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

  private hasPendingSpeakableText(state: ReplyStreamState): boolean {
    return state.speakableBuffer.trim().length > 0
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

    if (chunkIndex === 0) {
      callbacks.onMetrics?.({ firstTtsRequestAt: synthStartedAt })
    }

    this.logger.log(
      `[ASSISTANT AUDIO CHUNK] session=${input.sessionId} index=${chunkIndex} chars=${normalizedText.length} last=${isLastChunk}`,
    )

    const synthesized = await this.synthesisService.synthesize(normalizedText)
    const synthDurationMs = Date.now() - synthStartedAt
    const synthCompletedAt = Date.now()

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

    callbacks.onMetrics?.({
      lastTtsCompletedAt: synthCompletedAt,
      [`ttsChunk${chunkIndex}DurationMs`]: synthDurationMs,
      ttsChunkCount: state.audioChunkIndex,
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

  private normalizeConversationMetrics(
    metrics: {
      requestStartedAt?: number
      streamCreatedAt?: number
      firstDeltaAt?: number
      completedAt?: number
    },
  ): Record<string, number> {
    const out: Record<string, number> = {}

    if (metrics.requestStartedAt != null) {
      out.llmRequestStartedAt = metrics.requestStartedAt
    }
    if (metrics.streamCreatedAt != null) {
      out.llmStreamCreatedAt = metrics.streamCreatedAt
    }
    if (metrics.firstDeltaAt != null) {
      out.llmFirstDeltaAt = metrics.firstDeltaAt
    }
    if (metrics.completedAt != null) {
      out.llmCompletedAt = metrics.completedAt
    }

    return out
  }
}
