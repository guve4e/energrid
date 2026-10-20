import { LlmGatewayService, OpenAiDeviceLlmProvider } from './llm-gateway.service'
import type { LlmProvider } from './llm-provider'

describe('LlmGatewayService', () => {
  const originalMode = process.env.ENERGRID_LLM_MODE
  const originalProvider = process.env.ENERGRID_LLM_PROVIDER
  const originalApiKey = process.env.OPENAI_API_KEY

  afterEach(() => {
    if (originalMode === undefined) {
      delete process.env.ENERGRID_LLM_MODE
    } else {
      process.env.ENERGRID_LLM_MODE = originalMode
    }

    if (originalProvider === undefined) {
      delete process.env.ENERGRID_LLM_PROVIDER
    } else {
      process.env.ENERGRID_LLM_PROVIDER = originalProvider
    }
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = originalApiKey
  })

  const request = {
    systemPrompt: 'Analyze evidence',
    userPrompt: '{"observations":[]}',
  }

  it('defaults to local-only', () => {
    delete process.env.ENERGRID_LLM_MODE
    expect(new LlmGatewayService().getMode()).toBe('local-only')
  })

  it('rejects cloud inference in local-only mode', async () => {
    process.env.ENERGRID_LLM_MODE = 'local-only'
    process.env.ENERGRID_LLM_PROVIDER = 'openai'

    const gateway = new LlmGatewayService()

    await expect(gateway.generate(request))
      .rejects.toThrow('Cloud providers are prohibited')
  })

  it('does not silently fall back to cloud', async () => {
    process.env.ENERGRID_LLM_MODE = 'local-only'
    delete process.env.ENERGRID_LLM_PROVIDER

    const gateway = new LlmGatewayService()

    await expect(gateway.generate(request))
      .rejects.toThrow('unavailable')
  })

  it('reports OpenAI availability from the configured secret source without exposing the key', () => {
    delete process.env.OPENAI_API_KEY
    expect(new OpenAiDeviceLlmProvider().isAvailable()).toBe(false)
    process.env.OPENAI_API_KEY = 'test-only-secret'
    expect(new OpenAiDeviceLlmProvider().isAvailable()).toBe(true)
  })

  it('rejects inference when disabled', async () => {
    process.env.ENERGRID_LLM_MODE = 'disabled'

    await expect(new LlmGatewayService().generate(request))
      .rejects.toThrow('disabled')
  })

  it('uses an explicitly enabled cloud provider', async () => {
    process.env.ENERGRID_LLM_MODE = 'cloud-enabled'
    process.env.ENERGRID_LLM_PROVIDER = 'openai'

    const generate = jest.fn().mockResolvedValue({
      text: 'Insufficient evidence',
      provider: 'openai',
      model: 'test-model',
    })

    const provider: LlmProvider = {
      id: 'openai',
      generate,
    }

    const gateway = new LlmGatewayService()
    gateway.registerProvider(provider)

    const result = await gateway.generate(request, { cloudDataConsent: true })

    expect(result.text).toBe('Insufficient evidence')
    expect(generate).toHaveBeenCalledWith(request)
  })

  it('supports a local provider without cloud configuration', async () => {
    process.env.ENERGRID_LLM_MODE = 'local-only'
    process.env.ENERGRID_LLM_PROVIDER = 'local'

    const gateway = new LlmGatewayService()

    gateway.registerProvider({
      id: 'local',
      generate: async () => ({
        text: 'Local analysis',
        provider: 'local',
        model: 'local-model',
      }),
    })

    await expect(gateway.generate(request))
      .resolves.toMatchObject({
        text: 'Local analysis',
        provider: 'local',
      })
  })

  it('requires explicit consent before a cloud provider receives evidence', async () => {
    process.env.ENERGRID_LLM_MODE = 'cloud-enabled'
    process.env.ENERGRID_LLM_PROVIDER = 'openai'
    const generate = jest.fn()
    const gateway = new LlmGatewayService()
    gateway.registerProvider({ id: 'openai', generate })

    await expect(gateway.generate(request)).rejects.toThrow('Explicit cloud evidence consent')
    expect(generate).not.toHaveBeenCalled()
  })

  it('reports the missing default local provider without falling back to cloud', () => {
    delete process.env.ENERGRID_LLM_MODE
    delete process.env.ENERGRID_LLM_PROVIDER
    expect(new LlmGatewayService().availability()).toMatchObject({
      mode: 'local-only', provider: 'local', available: false, reasonCode: 'provider_unavailable',
    })
  })
})
