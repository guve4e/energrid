import { VoiceSessionService } from './voice-session.service'
import type { ActiveVoiceSession } from './voice-session.types'

describe('VoiceSessionService home automation fast path', () => {
  it('answers explicit room measurements from authorized Core state before legacy home context', async () => {
    const streamStaticReply = jest.fn(async input => input.replyText)
    const replyStreamer = { streamStaticReply }
    const trace = {
      appendAssistantFinalTrace: jest.fn(),
      appendAssistantTextDeltaTrace: jest.fn(),
      logTurnMetrics: jest.fn(),
    }
    const emitter = {
      emitAssistantTextDelta: jest.fn(),
      emitAssistantAudioChunk: jest.fn(),
      emitAssistantFinal: jest.fn(),
    }
    const homeAutomation = { getHomeContext: jest.fn() }
    const service = new VoiceSessionService(
      {} as any,
      replyStreamer as any,
      trace as any,
      emitter as any,
      homeAutomation as any,
    ) as any
    service.deviceRegistry = {
      getSnapshot: () => ({
        tenant: { id: 'tenant-demo' },
        site: { id: 'site-home' },
      }),
    }
    service.deviceIntelligence = {
      readRoomMeasurement: jest.fn().mockResolvedValue({
        status: 'measurement',
        room: 'Kitchen',
        metric: 'temperature',
        value: 7.1,
        freshness: 'fresh',
        observedAt: '2026-10-24T07:13:00.000Z',
      }),
    }
    const session = {
      id: 'voice-measurement',
      conversationId: 'voice-measurement-conversation',
      finalTranscript: 'Здрасти, Енергрид. Каква е температурата в кухнята?',
      timings: {},
    } as any

    await service.generateAssistantReply(session)

    expect(service.deviceIntelligence.readRoomMeasurement).toHaveBeenCalledWith(
      { tenantId: 'tenant-demo', siteId: 'site-home' },
      'кухнята',
      'temperature',
    )
    expect(homeAutomation.getHomeContext).not.toHaveBeenCalled()
    expect(session.assistantReply).toContain('7,1')
    expect(session.assistantReply).toContain('Измерването е актуално')
    expect(session.assistantReply).not.toContain('22,4')
    expect(emitter.emitAssistantFinal).toHaveBeenCalledWith(session)
  })

  it('executes a device action only after its one-time approval is confirmed', async () => {
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
      emitHomeActionExecution: jest.fn(),
      emitAssistantTextDelta: jest.fn(),
      emitAssistantAudioChunk: jest.fn(),
      emitAssistantFinal: jest.fn(),
      emitActionConfirmationRequired: jest.fn(),
      emitActionConfirmationResult: jest.fn(),
    }
    const homeAutomation = {
      getHomeContext: jest.fn(async () => ({
        outsideDark: true,
        insideTempC: 22.4,
        targetTempC: 21,
        comfortTempC: 22,
        homeMode: 'home',
        availableDevices: ['kitchen_light', 'kitchen_temperature'],
        occupiedRooms: [],
        alarmArmed: false,
      })),
      executePlan: jest.fn(async (plan) =>
        plan.actions.map((action) => ({
          action,
          status: 'success',
          adapter: 'http',
          message: 'ok',
        })),
      ),
    }

    const service = new VoiceSessionService(
      sttService as any,
      replyStreamer as any,
      trace as any,
      emitter as any,
      homeAutomation as any,
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
        replyText: expect.stringContaining('натиснете „Потвърди“'),
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
    expect(homeAutomation.executePlan).not.toHaveBeenCalled()
    expect(emitter.emitActionConfirmationRequired).toHaveBeenCalledWith(
      session,
      expect.any(String),
      expect.any(Number),
      expect.objectContaining({ intent: 'turn_on_lights' }),
    )
    expect(session.counters.commandFastPath).toBe(1)
    expect(session.assistantReply).toContain('Потвърди')

    const client = {} as any
    service.sessions.set(client, session)
    const approvalId = session.pendingActionApproval.id
    await service.confirmPendingAction(client, approvalId)

    expect(homeAutomation.executePlan).toHaveBeenCalledTimes(1)
    expect(emitter.emitHomeActionExecution).toHaveBeenCalledTimes(1)
    expect(emitter.emitActionConfirmationResult).toHaveBeenCalledWith(
      session,
      'completed',
      expect.any(Array),
    )

    await service.confirmPendingAction(client, approvalId)
    expect(homeAutomation.executePlan).toHaveBeenCalledTimes(1)

    session.pendingActionApproval = {
      id: 'expired-approval',
      plan: session.homeIntentPlan!,
      expiresAt: Date.now() - 1,
      timer: setTimeout(() => undefined, 10_000),
    }
    await service.confirmPendingAction(client, 'expired-approval')
    expect(homeAutomation.executePlan).toHaveBeenCalledTimes(1)
    expect(emitter.emitActionConfirmationResult).toHaveBeenLastCalledWith(
      session,
      'expired',
    )

    session.pendingActionApproval = {
      id: 'cancelled-approval',
      plan: session.homeIntentPlan!,
      expiresAt: Date.now() + 10_000,
      timer: setTimeout(() => undefined, 10_000),
    }
    service.cancelPendingAction(client, 'cancelled-approval')
    expect(homeAutomation.executePlan).toHaveBeenCalledTimes(1)
    expect(emitter.emitActionConfirmationResult).toHaveBeenLastCalledWith(
      session,
      'cancelled',
    )
  })

  it('describes pending device commands as awaiting confirmation', () => {
    const service = Object.create(VoiceSessionService.prototype) as any

    expect(
      service.withExecutionSummary('Включвам лампите.', [
        { status: 'pending', message: 'waiting', adapter: 'mqtt' },
      ]),
    ).toContain('все още чакам потвърждение')
  })

  it('runs the speech gate before sending buffered audio to STT', async () => {
    const sttSession = {
      pushAudio: jest.fn(),
      endInput: jest.fn(),
      close: jest.fn(),
      onEvent: jest.fn(),
    }
    const trace = {
      logSessionStart: jest.fn(),
      appendAudioAnalysisTrace: jest.fn(),
      appendSpeechGateDroppedTrace: jest.fn(),
      recordCompletedTurn: jest.fn(),
    }
    const emitter = {
      emitSessionStart: jest.fn(),
      emitChunkDebug: jest.fn(),
      emitTurnEnd: jest.fn(),
    }
    const service = new VoiceSessionService(
      { createSession: jest.fn().mockResolvedValue(sttSession), isStreamingMode: () => false } as any,
      {} as any,
      trace as any,
      emitter as any,
      {} as any,
    )
    const socket = { close: jest.fn() } as any

    await service.openSession(socket)
    await service.pushAudio(socket, Buffer.alloc(3200))
    await service.endTurn(socket)

    expect(sttSession.pushAudio).not.toHaveBeenCalled()
    expect(sttSession.endInput).not.toHaveBeenCalled()
    expect(emitter.emitTurnEnd).toHaveBeenCalledTimes(1)
  })

  it('streams gated audio chunks as they arrive without replaying them at turn end', async () => {
    const sttSession = {
      pushAudio: jest.fn().mockResolvedValue(undefined),
      endInput: jest.fn().mockResolvedValue(undefined),
      close: jest.fn(),
      onEvent: jest.fn(),
    }
    const trace = {
      logSessionStart: jest.fn(),
      appendAudioAnalysisTrace: jest.fn(),
      appendSpeechGateDroppedTrace: jest.fn(),
      recordCompletedTurn: jest.fn(),
    }
    const emitter = {
      emitSessionStart: jest.fn(),
      emitChunkDebug: jest.fn(),
      emitTurnEnd: jest.fn(),
    }
    const service = new VoiceSessionService(
      { createSession: jest.fn().mockResolvedValue(sttSession), isStreamingMode: () => true } as any,
      {} as any,
      trace as any,
      emitter as any,
      {} as any,
    )
    const socket = { close: jest.fn() } as any
    const spokenChunk = Buffer.alloc(3200)
    for (let offset = 0; offset < spokenChunk.length; offset += 2) {
      spokenChunk.writeInt16LE(10_000, offset)
    }

    await service.openSession(socket)
    await service.pushAudio(socket, spokenChunk)
    expect(sttSession.pushAudio).toHaveBeenCalledTimes(1)
    expect(sttSession.endInput).not.toHaveBeenCalled()

    await service.endTurn(socket)
    expect(sttSession.pushAudio).toHaveBeenCalledTimes(1)
    expect(sttSession.endInput).toHaveBeenCalledTimes(1)
  })

  it('stops queued streaming audio and closes STT after a provider error', async () => {
    const sttSession = {
      pushAudio: jest.fn(),
      endInput: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
      onEvent: jest.fn(),
    }
    const trace = { appendSttErrorTrace: jest.fn() }
    const emitter = { emitError: jest.fn() }
    const service = new VoiceSessionService(
      {} as any,
      {} as any,
      trace as any,
      emitter as any,
      {} as any,
    ) as any
    const session = {
      id: 'voice-session-failed-stt',
      clientTurnEnded: false,
      finalized: false,
      pendingFinalTranscript: '',
      sttFailed: false,
      sttSession,
      sttPushedChunkCount: 0,
      audioChunks: [Buffer.alloc(3200)],
    }

    await service.handleSttError(session, 'Speech recognition provider failed.', {
      providerEvent: 'error',
      providerCode: 'invalid_value',
    })
    await service.pushPendingSttAudio(session)

    expect(session.sttFailed).toBe(true)
    expect(sttSession.close).toHaveBeenCalledTimes(1)
    expect(sttSession.pushAudio).not.toHaveBeenCalled()
    expect(sttSession.endInput).not.toHaveBeenCalled()
    expect(trace.appendSttErrorTrace).toHaveBeenCalledWith(
      session,
      'Speech recognition provider failed.',
      { providerEvent: 'error', providerCode: 'invalid_value' },
    )
    expect(emitter.emitError).toHaveBeenCalledWith(
      session,
      'Speech recognition failed. Please try again.',
    )
  })

  it('closes a turn that exceeds the configured audio size', async () => {
    const sttSession = {
      pushAudio: jest.fn(),
      endInput: jest.fn(),
      close: jest.fn(),
      onEvent: jest.fn(),
    }
    const emitter = {
      emitSessionStart: jest.fn(),
      emitChunkDebug: jest.fn(),
      emitError: jest.fn(),
    }
    const service = new VoiceSessionService(
      { createSession: jest.fn().mockResolvedValue(sttSession), isStreamingMode: () => false } as any,
      {} as any,
      { logSessionStart: jest.fn() } as any,
      emitter as any,
      {} as any,
    ) as any
    service.maxAudioBytes = 2
    const socket = { close: jest.fn() } as any

    await service.openSession(socket)
    await service.pushAudio(socket, Buffer.alloc(3))

    expect(emitter.emitError).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('maximum audio size'),
    )
    expect(socket.close).toHaveBeenCalledWith(1009, 'Voice turn too large')
    expect(sttSession.pushAudio).not.toHaveBeenCalled()
  })
})
