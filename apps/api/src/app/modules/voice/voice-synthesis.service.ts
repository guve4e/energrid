import { Injectable, Logger } from '@nestjs/common'
import OpenAI from 'openai'

export interface SynthesizedVoiceAudio {
  format: 'wav'
  audioBuffer: Buffer
}

@Injectable()
export class VoiceSynthesisService {
  private readonly logger = new Logger(VoiceSynthesisService.name)
  private readonly openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  })

  async synthesize(text: string): Promise<SynthesizedVoiceAudio> {
    this.logger.log(`Synthesizing assistant audio for text length=${text.length}`)

    const response = await this.openai.audio.speech.create({
      model: 'gpt-4o-mini-tts',
      voice: 'alloy',
      response_format: 'wav',
      input: text,
    })

    const arrayBuffer = await response.arrayBuffer()
    const audioBuffer = Buffer.from(arrayBuffer)

    return {
      format: 'wav',
      audioBuffer,
    }
  }

  splitIntoSpeechChunks(text: string): string[] {
    const normalized = text
      .replace(/\s+/g, ' ')
      .replace(/\n+/g, ' ')
      .trim()

    if (!normalized) return []

    const sentenceChunks = normalized
      .split(/(?<=[.!?…])\s+/)
      .map((part) => part.trim())
      .filter(Boolean)

    if (sentenceChunks.length <= 1) {
      return this.splitLongChunk(normalized)
    }

    const result: string[] = []

    for (const chunk of sentenceChunks) {
      if (chunk.length <= 140) {
        result.push(chunk)
        continue
      }

      result.push(...this.splitLongChunk(chunk))
    }

    return result
  }

  private splitLongChunk(text: string): string[] {
    if (text.length <= 140) return [text]

    const parts: string[] = []
    let remaining = text.trim()

    while (remaining.length > 140) {
      let splitAt = remaining.lastIndexOf(',', 140)
      if (splitAt < 60) {
        splitAt = remaining.lastIndexOf(' ', 140)
      }
      if (splitAt < 40) {
        splitAt = 140
      }

      const piece = remaining.slice(0, splitAt).trim()
      if (piece) {
        parts.push(piece)
      }

      remaining = remaining.slice(splitAt).trim()
    }

    if (remaining) {
      parts.push(remaining)
    }

    return parts
  }

  async synthesizeChunks(text: string): Promise<SynthesizedVoiceAudio[]> {
    const chunks = this.splitIntoSpeechChunks(text)

    this.logger.log(
      `Synthesizing assistant audio chunks count=${chunks.length} textLength=${text.length}`,
    )

    const result: SynthesizedVoiceAudio[] = []

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]

      this.logger.log(
        `Synthesizing chunk ${i + 1}/${chunks.length} length=${chunk.length}`,
      )

      const audio = await this.synthesize(chunk)
      result.push(audio)
    }

    return result
  }
}
