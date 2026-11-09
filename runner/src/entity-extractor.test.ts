import { describe, it, expect, vi } from 'vitest'
import { extractEntities } from './entity-extractor.js'
import type { LlmProvider } from './types.js'

function mockLlm(response: unknown): LlmProvider {
  return {
    complete: vi.fn(),
    completeJson: vi.fn().mockResolvedValue({ parsed: response }),
  }
}

describe('extractEntities', () => {
  it('should extract valid entities and relations', async () => {
    const llm = mockLlm({
      entities: [
        { name: 'BullMQ', type: 'technology', project: 'confyday', confidence: 0.9 },
        { name: 'Redis', type: 'service', confidence: 0.85 },
      ],
      relations: [
        { from: 'confyday', fromType: 'project', to: 'BullMQ', toType: 'technology', relationType: 'uses', confidence: 0.8 },
      ],
    })

    const result = await extractEntities(llm, 'The project uses BullMQ with Redis')

    expect(result.entities).toHaveLength(2)
    expect(result.entities[0]).toEqual({
      name: 'BullMQ',
      type: 'technology',
      project: 'confyday',
      confidence: 0.9,
    })

    expect(result.relations).toHaveLength(1)
    expect(result.relations[0]).toMatchObject({
      from: { name: 'confyday', type: 'project' },
      to: { name: 'BullMQ', type: 'technology' },
      relationType: 'uses',
    })
  })

  it('should filter out invalid entity types', async () => {
    const llm = mockLlm({
      entities: [
        { name: 'Valid', type: 'project', confidence: 0.8 },
        { name: 'Invalid', type: 'foobar', confidence: 0.8 },
        { name: '', type: 'project', confidence: 0.8 },
      ],
      relations: [],
    })

    const result = await extractEntities(llm, 'test')

    expect(result.entities).toHaveLength(1)
    expect(result.entities[0].name).toBe('Valid')
  })

  it('should filter out invalid relation types', async () => {
    const llm = mockLlm({
      entities: [],
      relations: [
        { from: 'A', fromType: 'project', to: 'B', toType: 'technology', relationType: 'uses' },
        { from: 'A', fromType: 'project', to: 'B', toType: 'technology', relationType: 'invalid_rel' },
        { from: '', fromType: 'project', to: 'B', toType: 'technology', relationType: 'uses' },
      ],
    })

    const result = await extractEntities(llm, 'test')

    expect(result.relations).toHaveLength(1)
    expect(result.relations[0].relationType).toBe('uses')
  })

  it('should default confidence to 0.8', async () => {
    const llm = mockLlm({
      entities: [{ name: 'Test', type: 'concept' }],
      relations: [],
    })

    const result = await extractEntities(llm, 'test')

    expect(result.entities[0].confidence).toBe(0.8)
  })

  it('should truncate input to 12k chars', async () => {
    const llm = mockLlm({ entities: [], relations: [] })
    const longText = 'x'.repeat(20_000)

    await extractEntities(llm, longText)

    expect(llm.completeJson).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: expect.any(String),
        }),
      ]),
      { maxTokens: 2000 },
    )

    const call = (llm.completeJson as ReturnType<typeof vi.fn>).mock.calls[0]
    const userContent = call[0][1].content
    expect(userContent.length).toBeLessThanOrEqual(12_000)
  })
})
