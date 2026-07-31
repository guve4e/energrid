import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common'
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { createInterface, type Interface } from 'readline'
import OpenAI from 'openai'
import { toFile } from 'openai/uploads'
import type {
  StreamingSttEvent,
  StreamingSttSession,
} from '@energrid/stt-stream-core'

const execFileAsync = promisify(execFile)

interface PendingWhisperRequest {
  resolve: (text: string) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
  startedAt: number
}

@Injectable()
export class VoiceSttService implements OnModuleDestroy {
  private readonly logger = new Logger(VoiceSttService.name)
  private localWhisperWorker: ChildProcessWithoutNullStreams | null = null
  private localWhisperWorkerLines: Interface | null = null
  private localWhisperPending = new Map<string, PendingWhisperRequest>()

  private readonly openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  })

  onModuleDestroy(): void {
    this.stopLocalWhisperWorker()
  }

  async createSession(
    onEvent: (event: StreamingSttEvent) => Promise<void>,
  ): Promise<StreamingSttSession> {
    this.logger.log('VoiceSttService.createSession called')

    const audioChunks: Buffer[] = []
    let ended = false
    let closed = false

    const emit = async (event: StreamingSttEvent): Promise<void> => {
      if (closed) return
      await onEvent(event)
    }

    const session: StreamingSttSession = {
      onEvent: () => {
        // no-op in this local buffered implementation
      },

      pushAudio: async (buf: Buffer): Promise<void> => {
        if (closed || ended) return
        if (!buf?.length) return
        audioChunks.push(Buffer.from(buf))
      },

      endInput: async (): Promise<void> => {
        if (closed || ended) return
        ended = true

        try {
          const audio = Buffer.concat(audioChunks)

          if (!audio.length) {
            await emit({
              type: 'stt_error',
              message:
                'Error committing input audio buffer: buffer too small. Expected at least 100ms of audio, but buffer only has 0.00ms of audio.',
            })
            return
          }

          const text = await this.transcribeBufferedAudio(audio)

          await emit({
            type: 'stt_final',
            text,
          })
        } catch (err) {
          const message =
            err instanceof Error ? err.message : 'Unknown streaming STT error'

          await emit({
            type: 'stt_error',
            message,
          })
        }
      },

      close: async (): Promise<void> => {
        closed = true
      },
    }

    this.logger.log('VoiceSttService session created')
    return session
  }

  async transcribeBufferedAudio(audio: Buffer): Promise<string> {
    if (!audio.length) return ''

    const startedAt = Date.now()
    const provider = this.getProvider()

    if (provider === 'local-whisper') {
      const text = await this.transcribeWithLocalWhisper(audio)
      this.logger.log(
        `[STT PROVIDER] provider=local-whisper bytes=${audio.length} durationMs=${Date.now() - startedAt} textChars=${text.length}`,
      )

      if (text || !this.shouldFallbackToOpenAI()) {
        return text
      }

      this.logger.warn('Local Whisper returned no text; falling back to OpenAI STT')
    }

    const text = await this.transcribeWithOpenAI(audio)
    this.logger.log(
      `[STT PROVIDER] provider=${provider === 'local-whisper' ? 'openai_fallback' : 'openai'} bytes=${audio.length} durationMs=${Date.now() - startedAt} textChars=${text.length}`,
    )

    return text
  }

  private getProvider(): 'openai' | 'local-whisper' {
    const provider = process.env.VOICE_STT_PROVIDER || process.env.STT_PROVIDER

    if (provider === 'local-whisper' || provider === 'faster-whisper') {
      return 'local-whisper'
    }

    return 'openai'
  }

  private shouldFallbackToOpenAI(): boolean {
    return process.env.LOCAL_WHISPER_FALLBACK_TO_OPENAI === 'true'
  }

  private async transcribeWithOpenAI(audio: Buffer): Promise<string> {
    try {
      const wav = this.pcm16ToWav(audio, 16000, 1)

      const file = await toFile(wav, 'turn.wav', {
        type: 'audio/wav',
      })

      const result = await this.openai.audio.transcriptions.create({
        file,
        model: process.env.BATCH_STT_MODEL || 'gpt-4o-transcribe',
        language: 'bg',
      })

      const text = (result.text || '').trim()

      this.logger.log(`[BATCH STT] ${text}`)

      return text
    } catch (err: any) {
      this.logger.error(
        `Batch STT failed: message=${err?.message || 'unknown'} code=${err?.code || '-'} cause=${err?.cause?.message || '-'}`,
      )
      return ''
    }
  }

  private async transcribeWithLocalWhisper(audio: Buffer): Promise<string> {
    const wav = this.pcm16ToWav(audio, 16000, 1)
    const wavPath = join(
      tmpdir(),
      `energrid-voice-${Date.now()}-${Math.random().toString(16).slice(2)}.wav`,
    )

    try {
      await fs.writeFile(wavPath, wav)

      const text = this.shouldUseLocalWhisperWorker()
        ? await this.transcribeWithLocalWhisperWorker(wavPath)
        : await this.transcribeWithLocalWhisperOnce(wavPath)

      this.logger.log(`[LOCAL WHISPER STT] ${text}`)

      return text
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'unknown'
      this.logger.error(`Local Whisper STT failed: ${message}`)
      return ''
    } finally {
      await fs.unlink(wavPath).catch(() => undefined)
    }
  }

  private shouldUseLocalWhisperWorker(): boolean {
    return process.env.LOCAL_WHISPER_WORKER !== 'false'
  }

  private async transcribeWithLocalWhisperOnce(wavPath: string): Promise<string> {
    const scriptPath =
      process.env.LOCAL_WHISPER_SCRIPT ||
      join(__dirname, 'assets', 'local-whisper-transcribe.py')

    const python = process.env.LOCAL_WHISPER_PYTHON || 'python3'
    const timeoutMs = Number(process.env.LOCAL_WHISPER_TIMEOUT_MS || 30000)

    const { stdout, stderr } = await execFileAsync(
      python,
      [scriptPath, wavPath],
      {
        env: process.env,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
      },
    )

    if (stderr.trim()) {
      this.logger.debug(`[LOCAL WHISPER STDERR] ${stderr.trim()}`)
    }

    return stdout.trim()
  }

  private transcribeWithLocalWhisperWorker(wavPath: string): Promise<string> {
    const worker = this.ensureLocalWhisperWorker()
    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const timeoutMs = Number(process.env.LOCAL_WHISPER_TIMEOUT_MS || 30000)

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.localWhisperPending.delete(requestId)
        reject(new Error(`Local Whisper worker timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      this.localWhisperPending.set(requestId, {
        resolve,
        reject,
        timeout,
        startedAt: Date.now(),
      })

      const payload = JSON.stringify({ id: requestId, audioPath: wavPath })

      try {
        worker.stdin.write(`${payload}\n`, 'utf8')
      } catch (error) {
        clearTimeout(timeout)
        this.localWhisperPending.delete(requestId)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private ensureLocalWhisperWorker(): ChildProcessWithoutNullStreams {
    if (this.localWhisperWorker && !this.localWhisperWorker.killed) {
      return this.localWhisperWorker
    }

    const python = process.env.LOCAL_WHISPER_PYTHON || 'python3'
    const scriptPath =
      process.env.LOCAL_WHISPER_WORKER_SCRIPT ||
      join(__dirname, 'assets', 'local-whisper-worker.py')

    this.logger.log(
      `[LOCAL WHISPER WORKER] starting python=${python} script=${scriptPath}`,
    )

    const worker = spawn(python, [scriptPath], {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.localWhisperWorker = worker
    this.localWhisperWorkerLines = createInterface({
      input: worker.stdout,
      crlfDelay: Infinity,
    })

    this.localWhisperWorkerLines.on('line', (line) => {
      this.handleLocalWhisperWorkerLine(line)
    })

    worker.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8').trim()
      if (text) this.logger.log(`[LOCAL WHISPER WORKER] ${text}`)
    })

    worker.on('error', (error) => {
      this.logger.error(`Local Whisper worker failed: ${error.message}`)
      this.rejectLocalWhisperPending(error)
      this.localWhisperWorker = null
    })

    worker.on('exit', (code, signal) => {
      this.logger.warn(
        `[LOCAL WHISPER WORKER] exited code=${code ?? '-'} signal=${signal ?? '-'}`,
      )
      this.rejectLocalWhisperPending(
        new Error(`Local Whisper worker exited code=${code ?? '-'} signal=${signal ?? '-'}`),
      )
      this.localWhisperWorkerLines?.close()
      this.localWhisperWorkerLines = null
      this.localWhisperWorker = null
    })

    return worker
  }

  private handleLocalWhisperWorkerLine(line: string): void {
    let message: {
      id?: string
      text?: string
      error?: string
      durationMs?: number
      type?: string
    }

    try {
      message = JSON.parse(line)
    } catch {
      this.logger.warn(`[LOCAL WHISPER WORKER] non-json stdout: ${line}`)
      return
    }

    if (message.type === 'ready') {
      this.logger.log(
        `[LOCAL WHISPER WORKER] ready model=${message.text || '-'} durationMs=${message.durationMs ?? '-'}`,
      )
      return
    }

    if (!message.id) {
      this.logger.warn(`[LOCAL WHISPER WORKER] missing request id: ${line}`)
      return
    }

    const pending = this.localWhisperPending.get(message.id)
    if (!pending) return

    clearTimeout(pending.timeout)
    this.localWhisperPending.delete(message.id)

    if (message.error) {
      pending.reject(new Error(message.error))
      return
    }

    this.logger.log(
      `[LOCAL WHISPER WORKER] request=${message.id} durationMs=${message.durationMs ?? Date.now() - pending.startedAt}`,
    )
    pending.resolve((message.text || '').trim())
  }

  private rejectLocalWhisperPending(error: Error): void {
    for (const [id, pending] of this.localWhisperPending.entries()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
      this.localWhisperPending.delete(id)
    }
  }

  private stopLocalWhisperWorker(): void {
    this.rejectLocalWhisperPending(new Error('Local Whisper worker stopped'))
    this.localWhisperWorkerLines?.close()
    this.localWhisperWorkerLines = null
    this.localWhisperWorker?.kill()
    this.localWhisperWorker = null
  }

  private pcm16ToWav(
    pcm16: Buffer,
    sampleRate = 16000,
    channels = 1,
  ): Buffer {
    const bitsPerSample = 16
    const byteRate = sampleRate * channels * (bitsPerSample / 8)
    const blockAlign = channels * (bitsPerSample / 8)
    const dataSize = pcm16.length
    const buffer = Buffer.alloc(44 + dataSize)

    buffer.write('RIFF', 0)
    buffer.writeUInt32LE(36 + dataSize, 4)
    buffer.write('WAVE', 8)

    buffer.write('fmt ', 12)
    buffer.writeUInt32LE(16, 16)
    buffer.writeUInt16LE(1, 20)
    buffer.writeUInt16LE(channels, 22)
    buffer.writeUInt32LE(sampleRate, 24)
    buffer.writeUInt32LE(byteRate, 28)
    buffer.writeUInt16LE(blockAlign, 32)
    buffer.writeUInt16LE(bitsPerSample, 34)

    buffer.write('data', 36)
    buffer.writeUInt32LE(dataSize, 40)
    pcm16.copy(buffer, 44)

    return buffer
  }
}
