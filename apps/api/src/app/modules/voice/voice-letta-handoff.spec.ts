import { VoiceSessionService } from './voice-session.service';
import { FileInteractionTraceStore } from '../observability/file-interaction-trace.store';
import type { ActiveVoiceSession } from './voice-session.types';

const originalProvider = process.env.VOICE_ASSISTANT_PROVIDER;

afterEach(() => {
  if (originalProvider === undefined) {
    delete process.env.VOICE_ASSISTANT_PROVIDER;
  } else {
    process.env.VOICE_ASSISTANT_PROVIDER = originalProvider;
  }
  jest.restoreAllMocks();
});

describe('Voice → scoped Letta handoff', () => {
  it('uses Letta exactly once and preserves existing voice output', async () => {
    process.env.VOICE_ASSISTANT_PROVIDER = 'letta';

    const talk = jest.fn().mockResolvedValue({
      text: 'Готово, светнах лампата.',
      conversationId: 'letta-house-agent',
    });

    const streamStaticReply = jest.fn().mockResolvedValue(
      'Готово, светнах лампата.',
    );

    const streamReply = jest.fn();

    const traceService = {
      appendAssistantFinalTrace: jest.fn(),
      logTurnMetrics: jest.fn(),
    };

    const emitter = {
      emitAssistantFinal: jest.fn(),
    };

    const service = new VoiceSessionService(
      {} as ConstructorParameters<typeof VoiceSessionService>[0],
      {
        streamStaticReply,
        streamReply,
      } as unknown as ConstructorParameters<
        typeof VoiceSessionService
      >[1],
      traceService as unknown as ConstructorParameters<
        typeof VoiceSessionService
      >[2],
      emitter as unknown as ConstructorParameters<
        typeof VoiceSessionService
      >[3],
      {} as ConstructorParameters<typeof VoiceSessionService>[4],
    );

    const internal = service as unknown as {
      houseAgent: { talk: typeof talk };
      deviceRegistry: {
        getSnapshot: () => {
          tenant: { id: string };
          site: { id: string };
        };
      };
      generateAssistantReply(
        session: ActiveVoiceSession,
      ): Promise<void>;
      tryGenerateAutomationReply: (
        session: ActiveVoiceSession,
      ) => Promise<boolean>;
    };

    internal.houseAgent = { talk };
    internal.deviceRegistry = {
      getSnapshot: () => ({
        tenant: { id: 'tenant-demo' },
        site: { id: 'site-home' },
      }),
    };

    const legacyPlanner = jest.spyOn(
      internal,
      'tryGenerateAutomationReply',
    );

    const saved: unknown[] = [];

    jest.spyOn(FileInteractionTraceStore.prototype, 'save')
      .mockImplementation(async record => {
        saved.push(record);
      });

    const session = {
      id: 'voice-test',
      conversationId: 'voice-conversation',
      finalTranscript: 'Светни лампата в кухнята.',
      assistantReply: '',
      timings: {},
    } as unknown as ActiveVoiceSession;

    await internal.generateAssistantReply(session);

    expect(talk).toHaveBeenCalledTimes(1);
    expect(talk).toHaveBeenCalledWith(
      { tenantId: 'tenant-demo', siteId: 'site-home' },
      'Светни лампата в кухнята.',
    );

    expect(streamStaticReply).toHaveBeenCalledTimes(1);
    expect(streamStaticReply).toHaveBeenCalledWith(
      expect.objectContaining({
        replyText: 'Готово, светнах лампата.',
      }),
      expect.any(Object),
    );

    expect(legacyPlanner).not.toHaveBeenCalled();
    expect(streamReply).not.toHaveBeenCalled();
    expect(session.assistantReply).toBe(
      'Готово, светнах лампата.',
    );
    expect(emitter.emitAssistantFinal).toHaveBeenCalledTimes(1);

    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      origin: 'voice',
      outcome: 'succeeded',
      spans: expect.arrayContaining([
        expect.objectContaining({
          stage: 'assistant.turn',
        }),
        expect.objectContaining({
          stage: 'assistant.respond',
        }),
      ]),
    });
  });
});
