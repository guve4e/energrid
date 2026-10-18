import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common'
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { createInterface, type Interface } from 'node:readline'
import type { SpeechToTextProvider, SpeechToTextRequest } from '@energrid/domain-voice'
import { pcm16MonoToWav } from './speech-audio.util'

const execFileAsync = promisify(execFile)

interface PendingRequest {
  resolve(text: string): void
  reject(error: Error): void
  timeout: NodeJS.Timeout
}

@Injectable()
export class LocalWhisperSttProvider implements SpeechToTextProvider, OnModuleDestroy {
  readonly id = 'local-whisper'
  private readonly logger = new Logger(LocalWhisperSttProvider.name)
  private worker: ChildProcessWithoutNullStreams | null = null
  private workerLines: Interface | null = null
  private readonly pending = new Map<string, PendingRequest>()

  onModuleDestroy(): void {
    this.stopWorker()
  }

  async transcribe(request: SpeechToTextRequest): Promise<string> {
    const wavPath = join(tmpdir(), `energrid-voice-${randomUUID()}.wav`)
    await fs.writeFile(wavPath, pcm16MonoToWav(request.audio, request.sampleRateHz))

    try {
      const text = this.useWorker()
        ? await this.transcribeWithWorker(wavPath)
        : await this.transcribeOnce(wavPath)
      return text.trim()
    } finally {
      await fs.unlink(wavPath).catch(() => undefined)
    }
  }

  private useWorker(): boolean {
    return process.env.LOCAL_WHISPER_WORKER !== 'false'
  }

  private async transcribeOnce(wavPath: string): Promise<string> {
    const scriptPath =
      process.env.LOCAL_WHISPER_SCRIPT ||
      join(__dirname, 'assets', 'local-whisper-transcribe.py')
    const python = process.env.LOCAL_WHISPER_PYTHON || 'python3'
    const { stdout } = await execFileAsync(python, [scriptPath, wavPath], {
      env: process.env,
      timeout: localWhisperTimeoutMs(),
      maxBuffer: 1024 * 1024,
    })
    return stdout.trim()
  }

  private transcribeWithWorker(wavPath: string): Promise<string> {
    const worker = this.ensureWorker()
    const id = randomUUID()

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Local speech recognition timed out.'))
      }, localWhisperTimeoutMs())
      this.pending.set(id, { resolve, reject, timeout })

      try {
        worker.stdin.write(`${JSON.stringify({ id, audioPath: wavPath })}\n`, 'utf8')
      } catch (error) {
        clearTimeout(timeout)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error('Local speech worker failed.'))
      }
    })
  }

  private ensureWorker(): ChildProcessWithoutNullStreams {
    if (this.worker && !this.worker.killed) return this.worker

    const python = process.env.LOCAL_WHISPER_PYTHON || 'python3'
    const scriptPath =
      process.env.LOCAL_WHISPER_WORKER_SCRIPT ||
      join(__dirname, 'assets', 'local-whisper-worker.py')
    const worker = spawn(python, [scriptPath], {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.worker = worker
    this.workerLines = createInterface({ input: worker.stdout, crlfDelay: Infinity })
    this.workerLines.on('line', (line) => this.handleWorkerLine(line))
    worker.stderr.on('data', (chunk) => {
      if (chunk.toString('utf8').trim()) this.logger.warn('Local speech worker wrote to stderr.')
    })
    worker.on('error', () => {
      this.rejectPending(new Error('Local speech worker failed.'))
      this.worker = null
    })
    worker.on('exit', () => {
      this.rejectPending(new Error('Local speech worker stopped.'))
      this.workerLines?.close()
      this.workerLines = null
      this.worker = null
    })
    return worker
  }

  private handleWorkerLine(line: string): void {
    let message: { id?: string; text?: string; error?: string; type?: string }
    try {
      message = JSON.parse(line)
    } catch {
      this.logger.warn('Local speech worker returned an invalid response.')
      return
    }
    if (message.type === 'ready' || !message.id) return

    const request = this.pending.get(message.id)
    if (!request) return
    clearTimeout(request.timeout)
    this.pending.delete(message.id)
    if (message.error) {
      request.reject(new Error('Local speech recognition failed.'))
      return
    }
    request.resolve((message.text || '').trim())
  }

  private rejectPending(error: Error): void {
    for (const [id, request] of this.pending) {
      clearTimeout(request.timeout)
      this.pending.delete(id)
      request.reject(error)
    }
  }

  private stopWorker(): void {
    this.rejectPending(new Error('Local speech worker stopped.'))
    this.workerLines?.close()
    this.workerLines = null
    this.worker?.kill()
    this.worker = null
  }
}

export function localWhisperTimeoutMs(): number {
  const configured = Number(process.env.LOCAL_WHISPER_TIMEOUT_MS)
  if (!Number.isFinite(configured)) return 30_000
  return Math.max(1_000, Math.min(120_000, Math.floor(configured)))
}
