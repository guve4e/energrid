import {
  FastLightingCommandUseCase,
} from './fast-lighting-command.use-case';

const scope = {
  tenantId: 'tenant-home',
  siteId: 'site-house',
};

function harness() {
  const gateway = {
    listTrustedRooms: jest.fn().mockResolvedValue([
      {
        roomId: 'kitchen',
        aliases: ['кухнята', 'кухня'],
      },
    ]),
    resolveTarget: jest.fn().mockResolvedValue({
      status: 'resolved',
      deviceId: 'kitchen-shelly',
    }),
    execute: jest.fn().mockResolvedValue({
      status: 'confirmed',
      traceId: 'trace-123',
    }),
  };

  return {
    gateway,
    useCase: new FastLightingCommandUseCase(gateway),
  };
}

describe('FastLightingCommandUseCase', () => {
  it('executes a clear ON command exactly once', async () => {
    const h = harness();

    const result = await h.useCase.handle(
      scope,
      'Светни лампата в кухнята.',
    );

    expect(result).toEqual({
      kind: 'handled',
      outcome: 'confirmed',
      reply: 'Готово, светнах лампата.',
      traceId: 'trace-123',
    });

    expect(h.gateway.resolveTarget).toHaveBeenCalledWith(
      scope,
      'kitchen',
    );

    expect(h.gateway.execute).toHaveBeenCalledTimes(1);
    expect(h.gateway.execute).toHaveBeenCalledWith(
      scope,
      'kitchen-shelly',
      'turn_on',
    );
  });

  it('executes a clear OFF command exactly once', async () => {
    const h = harness();

    const result = await h.useCase.handle(
      scope,
      'Изгаси лампата в кухнята.',
    );

    expect(result).toMatchObject({
      kind: 'handled',
      outcome: 'confirmed',
      reply: 'Готово, изгасих лампата.',
    });

    expect(h.gateway.execute).toHaveBeenCalledTimes(1);
    expect(h.gateway.execute).toHaveBeenCalledWith(
      scope,
      'kitchen-shelly',
      'turn_off',
    );
  });

  it.each([
    'Не включвай лампата в кухнята.',
    'Много е тъмно тук.',
    'Светни лампата.',
    'Включи лампата в хола.',
    'Включи лампата в кухнята и в хола.',
    'Защо лампата не работи?',
    'Настрой термопомпата на 35 градуса.',
  ])('never executes ambiguous or unsupported input: %s', async text => {
    const h = harness();

    const result = await h.useCase.handle(scope, text);

    expect(result.kind).toBe('delegate');
    expect(h.gateway.resolveTarget).not.toHaveBeenCalled();
    expect(h.gateway.execute).not.toHaveBeenCalled();
  });

  it.each([
    'ambiguous',
    'not_found',
    'unavailable',
  ])('does not execute when target is %s', async status => {
    const h = harness();

    h.gateway.resolveTarget.mockResolvedValue({ status });

    const result = await h.useCase.handle(
      scope,
      'Светни лампата в кухнята.',
    );

    expect(result).toMatchObject({
      kind: 'handled',
      outcome: 'unresolved',
    });

    expect(h.gateway.execute).not.toHaveBeenCalled();
  });

  it('rejects an empty resolved device ID', async () => {
    const h = harness();

    h.gateway.resolveTarget.mockResolvedValue({
      status: 'resolved',
      deviceId: ' ',
    });

    const result = await h.useCase.handle(
      scope,
      'Светни лампата в кухнята.',
    );

    expect(result).toMatchObject({
      outcome: 'unresolved',
    });
    expect(h.gateway.execute).not.toHaveBeenCalled();
  });

  it('never claims success after Core denial', async () => {
    const h = harness();

    h.gateway.execute.mockResolvedValue({
      status: 'denied',
      reason: 'assistant_disabled',
    });

    const result = await h.useCase.handle(
      scope,
      'Светни лампата в кухнята.',
    );

    expect(result).toMatchObject({
      kind: 'handled',
      outcome: 'denied',
    });
    expect(result.kind === 'handled' && result.reply)
      .not.toContain('Готово');
  });

  it('never claims success for unverified execution', async () => {
    const h = harness();

    h.gateway.execute.mockResolvedValue({
      status: 'not_confirmed',
    });

    const result = await h.useCase.handle(
      scope,
      'Светни лампата в кухнята.',
    );

    expect(result).toMatchObject({
      outcome: 'not_confirmed',
    });
    expect(result.kind === 'handled' && result.reply)
      .not.toContain('Готово');
  });

  it('does not retry when execution throws', async () => {
    const h = harness();

    h.gateway.execute.mockRejectedValue(
      new Error('Shelly timeout'),
    );

    const result = await h.useCase.handle(
      scope,
      'Светни лампата в кухнята.',
    );

    expect(result).toMatchObject({
      kind: 'handled',
      outcome: 'failed',
    });
    expect(h.gateway.execute).toHaveBeenCalledTimes(1);
  });

  it('does not execute if trusted room loading fails', async () => {
    const h = harness();

    h.gateway.listTrustedRooms.mockRejectedValue(
      new Error('Inventory unavailable'),
    );

    const result = await h.useCase.handle(
      scope,
      'Светни лампата в кухнята.',
    );

    expect(result).toMatchObject({
      kind: 'handled',
      outcome: 'failed',
    });
    expect(h.gateway.execute).not.toHaveBeenCalled();
  });

  it('does not execute when Core resolution throws', async () => {
    const h = harness();

    h.gateway.resolveTarget.mockRejectedValue(
      new Error('Resolver unavailable'),
    );

    const result = await h.useCase.handle(
      scope,
      'Светни лампата в кухнята.',
    );

    expect(result).toMatchObject({
      outcome: 'failed',
    });
    expect(h.gateway.execute).not.toHaveBeenCalled();
  });

  it('rejects missing tenant scope', async () => {
    const h = harness();

    const result = await h.useCase.handle(
      { ...scope, tenantId: '' },
      'Светни лампата в кухнята.',
    );

    expect(result).toMatchObject({
      outcome: 'denied',
    });
    expect(h.gateway.listTrustedRooms).not.toHaveBeenCalled();
    expect(h.gateway.execute).not.toHaveBeenCalled();
  });

  it('rejects missing site scope', async () => {
    const h = harness();

    const result = await h.useCase.handle(
      { ...scope, siteId: '' },
      'Светни лампата в кухнята.',
    );

    expect(result).toMatchObject({
      outcome: 'denied',
    });
    expect(h.gateway.execute).not.toHaveBeenCalled();
  });

  it('uses trusted room aliases, never hardcoded device IDs', async () => {
    const h = harness();

    h.gateway.listTrustedRooms.mockResolvedValue([
      {
        roomId: 'custom-kitchen-room',
        aliases: ['кухнята'],
      },
    ]);

    h.gateway.resolveTarget.mockResolvedValue({
      status: 'resolved',
      deviceId: 'approved-device-from-core',
    });

    await h.useCase.handle(
      scope,
      'Включи лампата в кухнята.',
    );

    expect(h.gateway.resolveTarget).toHaveBeenCalledWith(
      scope,
      'custom-kitchen-room',
    );

    expect(h.gateway.execute).toHaveBeenCalledWith(
      scope,
      'approved-device-from-core',
      'turn_on',
    );
  });
});
