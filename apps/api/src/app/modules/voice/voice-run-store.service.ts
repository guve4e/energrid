import { Injectable, Logger } from '@nestjs/common'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { ActiveVoiceSession } from './voice-session.types'

export interface VoiceRunRecord {
  id: string
  type: 'voice_turn'
  sessionId: string
  conversationId: string
  createdAt: string
  completedAt: string
  transcript: string
  assistantReply: string
  intent: string | null
  classification: unknown
  plan: unknown
  executionResults: unknown[]
  metrics: unknown
  runtime: {
    sttProvider: string
    openaiBatchModel: string
    localWhisperWorker: boolean
    localWhisperModel: string
    localWhisperLanguage: string
  }
  errors: string[]
}

@Injectable()
export class VoiceRunStoreService {
  private readonly logger = new Logger(VoiceRunStoreService.name)
  private readonly recordedIds = new Set<string>()

  recordTurn(session: ActiveVoiceSession, metrics: unknown): VoiceRunRecord | null {
    if (!this.enabled()) return null

    const completedAtMs = session.turnEndEmittedAt ?? Date.now()
    const id = `${session.id}:${completedAtMs}`
    if (this.recordedIds.has(id)) return null
    this.recordedIds.add(id)

    const record: VoiceRunRecord = {
      id,
      type: 'voice_turn',
      sessionId: session.id,
      conversationId: session.conversationId,
      createdAt: new Date(session.startedAt).toISOString(),
      completedAt: new Date(completedAtMs).toISOString(),
      transcript: session.finalTranscript.trim(),
      assistantReply: session.assistantReply.trim(),
      intent: session.homeIntentClassification?.intent ?? null,
      classification: session.homeIntentClassification,
      plan: session.homeIntentPlan,
      executionResults: session.homeActionExecutionResults,
      metrics,
      runtime: this.runtimeSnapshot(),
      errors: session.errorMessages,
    }

    try {
      const file = this.filePath()
      mkdirSync(dirname(file), { recursive: true })
      appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8')
      return record
    } catch (error) {
      this.logger.warn(`Voice run record failed: ${errorMessage(error)}`)
      return null
    }
  }

  listRecent(limit = 50): VoiceRunRecord[] {
    const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)))
    const file = this.filePath()
    if (!existsSync(file)) return []

    try {
      return readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .reverse()
        .map((line) => safeJsonParse<VoiceRunRecord>(line))
        .filter((record): record is VoiceRunRecord => record != null)
        .slice(0, boundedLimit)
    } catch (error) {
      this.logger.warn(`Voice run read failed: ${errorMessage(error)}`)
      return []
    }
  }

  getInfo() {
    return {
      enabled: this.enabled(),
      file: this.filePath(),
    }
  }

  private enabled(): boolean {
    return process.env.VOICE_RUNS_ENABLED !== 'false'
  }

  private filePath(): string {
    return resolve(process.env.VOICE_RUNS_FILE || 'data/voice-runs.jsonl')
  }

  private runtimeSnapshot(): VoiceRunRecord['runtime'] {
    return {
      sttProvider: process.env.VOICE_STT_PROVIDER || process.env.STT_PROVIDER || 'openai',
      openaiBatchModel: process.env.BATCH_STT_MODEL || 'gpt-4o-transcribe',
      localWhisperWorker: process.env.LOCAL_WHISPER_WORKER !== 'false',
      localWhisperModel:
        process.env.LOCAL_WHISPER_MODEL_PATH ||
        process.env.LOCAL_WHISPER_MODEL ||
        'small',
      localWhisperLanguage: process.env.LOCAL_WHISPER_LANGUAGE || 'bg',
    }
  }
}

function safeJsonParse<T>(line: string): T | null {
  try {
    return JSON.parse(line) as T
  } catch {
    return null
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
