import { LlmGatewayService } from './llm-gateway.service'
import type { LlmProvider } from './llm-provider'

describe('LlmGatewayService', () => {
  const originalMode = process.env.ENERGRID_LLM_MODE
  const originalProvider = process.env.ENERGRID_LLM_PROVIDER

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

    const result = await gateway.generate(request)

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
})
