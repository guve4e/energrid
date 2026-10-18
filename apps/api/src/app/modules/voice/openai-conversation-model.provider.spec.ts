import { OpenAiConversationModelProvider } from './openai-conversation-model.provider'

describe('OpenAiConversationModelProvider', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv, OPENAI_API_KEY: 'test-key' }
    delete process.env.VOICE_CHAT_MODEL
    delete process.env.VOICE_CHAT_TIMEOUT_MS
  })

  afterAll(() => {
    process.env = originalEnv
  })

  it('maps provider deltas to the model-neutral stream contract with bounded timeout and no retries', async () => {
    const create = jest.fn().mockResolvedValue((async function* () {
      yield { type: 'response.output_text.delta', delta: 'Hi' }
      yield { type: 'response.completed' }
    })())
    const provider = new OpenAiConversationModelProvider() as any
    provider.client = { responses: { create } }
    process.env.VOICE_CHAT_MODEL = 'test-model'
    process.env.VOICE_CHAT_TIMEOUT_MS = '2000'

    const events = []
    for await (const event of provider.streamResponse({
      messages: [{ role: 'user', text: 'hello' }],
    })) events.push(event)

    expect(create).toHaveBeenCalledWith(
      { model: 'test-model', input: [{ role: 'user', content: 'hello' }], stream: true },
      { timeout: 2000, maxRetries: 0 },
    )
    expect(events).toEqual([
      { type: 'text_delta', text: 'Hi' },
      { type: 'completed' },
    ])
  })

  it('reports missing credentials without constructing or calling the SDK', () => {
    delete process.env.OPENAI_API_KEY
    const provider = new OpenAiConversationModelProvider()
    expect(provider.isConfigured()).toBe(false)
  })

  it('propagates SDK stream failures to the application boundary', async () => {
    const provider = new OpenAiConversationModelProvider() as any
    provider.client = {
      responses: {
        create: jest.fn().mockRejectedValue(new Error('upstream unavailable')),
      },
    }

    await expect(async () => {
      for await (const _event of provider.streamResponse({ messages: [] })) { /* consume */ }
    }).rejects.toThrow('upstream unavailable')
  })

  it('rejects a provider stream that ends without an explicit completion event', async () => {
    const provider = new OpenAiConversationModelProvider() as any
    provider.client = {
      responses: {
        create: jest.fn().mockResolvedValue((async function* () {
          yield { type: 'response.output_text.delta', delta: 'partial' }
        })()),
      },
    }

    await expect(async () => {
      for await (const _event of provider.streamResponse({ messages: [] })) { /* consume */ }
    }).rejects.toThrow('ended before completion')
  })
})
