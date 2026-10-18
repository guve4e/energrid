import type {
  ConversationModelEvent,
  ConversationModelProvider,
  ConversationModelRequest,
} from '@energrid/domain-voice'
import { VoiceConversationService } from './voice-conversation.service'

class FakeConversationModel implements ConversationModelProvider {
  readonly id = 'fake'
  configured = true
  request?: ConversationModelRequest
  events: ConversationModelEvent[] = [
    { type: 'text_delta', text: ' Здравей' },
    { type: 'text_delta', text: '!' },
    { type: 'completed' },
  ]
  failure?: Error

  isConfigured() {
    return this.configured
  }

  async *streamResponse(request: ConversationModelRequest) {
    this.request = request
    if (this.failure) throw this.failure
    yield* this.events
  }
}

describe('VoiceConversationService', () => {
  let model: FakeConversationModel
  let service: VoiceConversationService

  beforeEach(() => {
    model = new FakeConversationModel()
    service = new VoiceConversationService(model)
  })

  it('sends normalized Bulgarian prompt and conversation history through the model port', async () => {
    const first = await service.handleFinalTranscript({
      sessionId: 'session-a', conversationId: 'conversation-a', transcript: 'Здрасти',
    })
    expect(first.replyText).toBe('Здравей!')

    await service.handleFinalTranscript({
      sessionId: 'session-a', conversationId: 'conversation-a', transcript: 'Как си?',
    })

    expect(model.request?.messages[0]).toEqual(expect.objectContaining({
      role: 'system',
      text: expect.stringContaining('Always answer in natural Bulgarian.'),
    }))
    expect(model.request?.messages.slice(1)).toEqual([
      { role: 'user', text: 'Здрасти' },
      { role: 'assistant', text: 'Здравей!' },
      { role: 'user', text: 'Как си?' },
    ])
  })

  it('emits deltas and completion only after a successful stream', async () => {
    const deltas: string[] = []
    const completed: string[] = []
    const result = await service.handleFinalTranscriptStream(
      { sessionId: 's', conversationId: 'c', transcript: 'Здрасти' },
      {
        onTextDelta: (value) => { deltas.push(value) },
        onCompletedText: (value) => { completed.push(value) },
      },
    )

    expect(deltas).toEqual([' Здравей', '!'])
    expect(completed).toEqual(['Здравей!'])
    expect(result.replyText).toBe('Здравей!')
  })

  it('uses the existing spoken echo fallback when the provider is not configured', async () => {
    model.configured = false
    const completed: string[] = []

    await expect(service.handleFinalTranscriptStream(
      { sessionId: 's', conversationId: 'c', transcript: 'Тест' },
      { onCompletedText: (value) => { completed.push(value) } },
    )).resolves.toEqual({ replyText: 'Чух: Тест' })
    expect(completed).toEqual(['Чух: Тест'])
    expect(model.request).toBeUndefined()
  })

  it('propagates provider failures without reporting a completed reply', async () => {
    model.failure = new Error('provider timeout')
    const onCompletedText = jest.fn()

    await expect(service.handleFinalTranscriptStream(
      { sessionId: 's', conversationId: 'c', transcript: 'Тест' },
      { onCompletedText },
    )).rejects.toThrow('provider timeout')
    expect(onCompletedText).not.toHaveBeenCalled()
  })

  it('rejects a truncated stream that never signals completion', async () => {
    model.events = [{ type: 'text_delta', text: 'Partial' }]
    const onCompletedText = jest.fn()

    await expect(service.handleFinalTranscriptStream(
      { sessionId: 's', conversationId: 'c', transcript: 'Тест' },
      { onCompletedText },
    )).rejects.toThrow('ended before completion')
    expect(onCompletedText).not.toHaveBeenCalled()
  })

  it('keeps histories isolated by conversation and bounded to the latest turns', async () => {
    for (let i = 0; i < 8; i++) {
      await service.handleFinalTranscript({
        sessionId: 's', conversationId: 'one', transcript: `turn-${i}`,
      })
    }
    await service.handleFinalTranscript({
      sessionId: 's', conversationId: 'two', transcript: 'other',
    })
    await service.handleFinalTranscript({
      sessionId: 's', conversationId: 'one', transcript: 'latest',
    })

    expect(model.request?.messages.slice(1).map(({ text }) => text)).toHaveLength(12)
    expect(model.request?.messages.some(({ text }) => text === 'other')).toBe(false)
    expect(model.request?.messages.some(({ text }) => text === 'turn-0')).toBe(false)
    expect(model.request?.messages.at(-1)?.text).toBe('latest')
  })
})
