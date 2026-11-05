jest.mock('@letta-ai/letta-agent-sdk', () => ({
  LettaAgentClient: class {
    createAgent = jest.fn();
    resumeSession = jest.fn();
  },
}));

import { LettaHouseAgentAdapter } from '../llm/letta-house-agent.adapter';
import { FinanceAssistantTools } from '../llm/finance-assistant-tools';
import { VoiceSessionService } from './voice-session.service';
import { FileInteractionTraceStore } from '../observability/file-interaction-trace.store';
import type { ActiveVoiceSession } from './voice-session.types';

describe('Voice finance tool execution path', () => {
  const oldProvider = process.env.VOICE_ASSISTANT_PROVIDER;
  afterEach(() => {
    if (oldProvider === undefined) delete process.env.VOICE_ASSISTANT_PROVIDER;
    else process.env.VOICE_ASSISTANT_PROVIDER = oldProvider;
    jest.restoreAllMocks();
  });

  it('carries the authenticated voice principal into the shared finance application boundary', async () => {
    process.env.VOICE_ASSISTANT_PROVIDER = 'letta';
    const principal = { userId: 'voice-account', email: 'voice@example.test', name: 'Voice', role: 'admin' as const, sessionId: 'voice-session', sessionVersion: 1 };
    const proposal = {
      id: 'draft-voice-0001', accountId: principal.userId, status: 'proposed', date: '2026-10-27',
      amount: '76.00', currency: 'EUR', merchantName: 'Lidl', category: 'Groceries',
      description: 'Purchase at Lidl', tags: [], items: [], createdAt: '2026-10-27T12:00:00.000Z',
    };
    const financeApplication = {
      proposeExpenseDraft: jest.fn().mockResolvedValue(proposal),
      confirmExpense: jest.fn(),
    };
    const financeTools = new FinanceAssistantTools(financeApplication as never);
    const adapter = new LettaHouseAgentAdapter(
      {} as never, {} as never, {} as never, {} as never, {} as never,
      { read: jest.fn() } as never, financeTools,
      { tools: jest.fn().mockReturnValue([]) } as never,
    );
    (adapter as any).agentFor = jest.fn().mockResolvedValue('voice-agent');
    const client = (adapter as any).client;
    let sessionOptions: any;
    client.resumeSession.mockImplementation((_id: string, options: any) => {
      sessionOptions = options;
      return {
        send: jest.fn(),
        close: jest.fn(),
        stream: async function* () {
          const proposalTool = options.tools.find((item: any) => item.name === 'finance_propose_expense');
          await proposalTool.execute('voice-tool-call-1', {});
          yield { type: 'result', success: true, result: 'I have €76 at Lidl under Groceries. Shall I save it?', conversationId: 'voice-letta-conversation' };
        },
      };
    });

    const streamStaticReply = jest.fn().mockResolvedValue('I have €76 at Lidl under Groceries. Shall I save it?');
    const traceService = { appendAssistantFinalTrace: jest.fn(), logTurnMetrics: jest.fn() };
    const emitter = { emitAssistantFinal: jest.fn() };
    const voice = new VoiceSessionService(
      {} as never,
      { streamStaticReply, streamReply: jest.fn() } as never,
      traceService as never,
      emitter as never,
      {} as never,
    );
    const internal = voice as any;
    internal.houseAgent = adapter;
    internal.deviceRegistry = { getSnapshot: () => ({ tenant: { id: 'tenant' }, site: { id: 'site' } }) };
    jest.spyOn(FileInteractionTraceStore.prototype, 'save').mockResolvedValue(undefined);

    const activeSession = {
      id: 'voice-turn', conversationId: 'voice-opaque-conversation', principal,
      finalTranscript: 'I spent €76 at Lidl.', assistantReply: '', timings: {},
    } as unknown as ActiveVoiceSession;
    await internal.generateAssistantReply(activeSession);

    expect(sessionOptions.allowedTools).toContain('finance_propose_expense');
    expect(financeApplication.proposeExpenseDraft).toHaveBeenCalledWith(expect.objectContaining({
      accountId: principal.userId, text: 'I spent €76 at Lidl.', cloudDataConsent: false,
    }));
    expect(financeApplication.confirmExpense).not.toHaveBeenCalled();
    expect(streamStaticReply).toHaveBeenCalledWith(expect.objectContaining({
      replyText: 'I have €76 at Lidl under Groceries. Shall I save it?',
    }), expect.any(Object));
    expect(activeSession.assistantReply).toContain('Shall I save it?');
  });
});
