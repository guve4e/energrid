import { VoiceSessionService } from './voice-session.service'
import type { ActiveVoiceSession } from './voice-session.types'

describe('VoiceSessionService home automation fast path', () => {
  it('plans known home commands without using the general assistant stream', async () => {
    const sttService = {}
    const replyStreamer = {
      streamReply: jest.fn(),
      streamStaticReply: jest.fn(async (input, callbacks) => {
        callbacks.onTextDelta(input.replyText, input.replyText)
        callbacks.onMetrics({ firstTtsRequestAt: 110, lastTtsCompletedAt: 140 })
        callbacks.onAudioChunk({
          chunkIndex: 0,
          isLastChunk: true,
          text: input.replyText,
          format: 'wav',
          audioBuffer: Buffer.from([1, 2, 3]),
        })
        callbacks.onCompleted(input.replyText)
        return input.replyText
      }),
    }
    const trace = {
      appendAssistantTextDeltaTrace: jest.fn(),
      appendAssistantFinalTrace: jest.fn(),
      logTurnMetrics: jest.fn(),
    }
    const emitter = {
      emitHomeActionPlan: jest.fn(),
      emitAssistantTextDelta: jest.fn(),
      emitAssistantAudioChunk: jest.fn(),
      emitAssistantFinal: jest.fn(),
    }

    const service = new VoiceSessionService(
      sttService as any,
      replyStreamer as any,
      trace as any,
      emitter as any,
    ) as any

    const session = {
      id: 'voice-session-1',
      conversationId: 'conversation-1',
      finalTranscript: 'Включи лампите в кухнята.',
      assistantReply: '',
      assistantFirstDeltaAt: null,
      assistantFirstAudioAt: null,
      assistantFinalAt: null,
      timings: {},
      counters: {},
    } as ActiveVoiceSession

    await service.generateAssistantReply(session)

    expect(replyStreamer.streamReply).not.toHaveBeenCalled()
    expect(replyStreamer.streamStaticReply).toHaveBeenCalledWith(
      expect.objectContaining({
        transcript: 'Включи лампите в кухнята.',
        replyText: 'Включвам лампите.',
      }),
      expect.any(Object),
    )
    expect(emitter.emitHomeActionPlan).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ intent: 'turn_on_lights' }),
      expect.objectContaining({
        actions: expect.arrayContaining([
          expect.objectContaining({
            type: 'light.turn_on',
            deviceId: 'kitchen_light',
          }),
        ]),
      }),
    )
    expect(emitter.emitAssistantAudioChunk).toHaveBeenCalled()
    expect(emitter.emitAssistantFinal).toHaveBeenCalledWith(session)
    expect(session.counters.commandFastPath).toBe(1)
    expect(session.assistantReply).toBe('Включвам лампите.')
  })
})
