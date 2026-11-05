import { BadRequestException } from '@nestjs/common';
import { PortalController } from './portal.controller';
import { FileInteractionTraceStore } from '../observability/file-interaction-trace.store';

describe('Portal assistant chat identity propagation', () => {
  afterEach(() => jest.restoreAllMocks());

  function setup() {
    const principal = {
      userId: 'account-portal', email: 'portal@example.test', name: 'Portal',
      role: 'admin' as const, sessionId: 'session-portal', sessionVersion: 1,
    };
    const talk = jest.fn().mockResolvedValue({ text: 'Ready', conversationId: 'house-conversation' });
    const controller = Object.create(PortalController.prototype) as any;
    controller.deviceRegistry = { getSnapshot: () => ({ tenant: { id: 'tenant' }, site: { id: 'site' } }) };
    controller.houseAgent = { talk };
    jest.spyOn(FileInteractionTraceStore.prototype, 'save').mockResolvedValue(undefined);
    return { controller, principal, talk };
  }

  it('passes authenticated account identity and the client conversation handle to HouseAgentPort', async () => {
    const { controller, principal, talk } = setup();
    const result = await controller.chatWithEnergrid(
      { message: 'How much have I spent?', conversationId: 'opaque-handle' },
      { method: 'POST', originalUrl: '/portal/assistant/chat', headers: {}, user: principal },
    );
    expect(talk).toHaveBeenCalledWith({
      tenantId: 'tenant', siteId: 'site', principal, conversationId: 'opaque-handle',
    }, 'How much have I spent?');
    expect(result).toMatchObject({ reply: 'Ready', conversationId: 'house-conversation' });
  });

  it('keeps weather questions in the same authenticated assistant conversation', async () => {
    const { controller, principal, talk } = setup();
    const response = await controller.chatWithEnergrid(
      { message: 'Енергрид, ще вали ли утре?', conversationId: 'previous-house-conversation' },
      { method: 'POST', originalUrl: '/portal/assistant/chat', headers: {}, user: principal },
    );
    expect(talk).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant', siteId: 'site', principal, conversationId: 'previous-house-conversation',
    }), 'Енергрид, ще вали ли утре?');
    expect(response.conversationId).toBe('house-conversation');
  });

  it('rejects malformed conversation handles before calling the assistant', async () => {
    const { controller, talk } = setup();
    await expect(controller.chatWithEnergrid(
      { message: 'Hello', conversationId: { accountId: 'other' } },
      { method: 'POST', originalUrl: '/portal/assistant/chat', headers: {}, user: { userId: 'account-portal', role: 'admin' } },
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(talk).not.toHaveBeenCalled();
  });
});
