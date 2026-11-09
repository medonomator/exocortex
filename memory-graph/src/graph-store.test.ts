import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock pg module
const mockQuery = vi.fn()
const mockConnect = vi.fn()
const mockRelease = vi.fn()
const mockEnd = vi.fn()

class MockPool {
  query = mockQuery
  connect = mockConnect
  end = mockEnd
  on() { return this }
}

vi.mock('pg', () => ({
  default: { Pool: MockPool },
}))

// Import after mock
const { GraphStore } = await import('./graph-store.js')

describe('GraphStore', () => {
  let store: InstanceType<typeof GraphStore>

  beforeEach(() => {
    vi.clearAllMocks()
    mockConnect.mockResolvedValue({
      query: mockQuery,
      release: mockRelease,
    })
    store = new GraphStore({ host: 'localhost', port: 5433, user: 'test', password: 'test', database: 'test' })
  })

  describe('upsertEntity', () => {
    it('should insert entity and return id', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'uuid-1' }] })

      const id = await store.upsertEntity({
        name: 'BullMQ',
        type: 'technology',
        project: 'confyday',
        confidence: 0.9,
      })

      expect(id).toBe('uuid-1')
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO kg_entities'),
        ['BullMQ', 'technology', 'confyday', '{}', 0.9],
      )
    })

    it('should handle null project', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'uuid-2' }] })

      await store.upsertEntity({ name: 'Redis', type: 'service' })

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO kg_entities'),
        ['Redis', 'service', null, '{}', 1.0],
      )
    })
  })

  describe('batchUpsert', () => {
    it('should wrap in transaction', async () => {
      mockQuery
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'e1' }] }) // entity 1
        .mockResolvedValueOnce({ rows: [{ id: 'e2' }] }) // entity 2
        .mockResolvedValueOnce({ rows: [] }) // trigram search for entity 1
        .mockResolvedValueOnce({ rows: [] }) // trigram search for entity 2
        .mockResolvedValueOnce(undefined) // COMMIT

      const result = await store.batchUpsert(
        [
          { name: 'A', type: 'project' },
          { name: 'B', type: 'technology' },
        ],
        [],
      )

      expect(result).toEqual({ entities: 2, relations: 0, autoLinked: 0 })
      expect(mockQuery).toHaveBeenCalledWith('BEGIN')
      expect(mockQuery).toHaveBeenCalledWith('COMMIT')
    })

    it('should rollback on error', async () => {
      mockQuery
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockRejectedValueOnce(new Error('DB error')) // entity fails

      await expect(store.batchUpsert([{ name: 'A', type: 'project' }], []))
        .rejects.toThrow('DB error')

      expect(mockQuery).toHaveBeenCalledWith('ROLLBACK')
    })
  })

  describe('getEntity', () => {
    it('should return entity by name (case-insensitive)', async () => {
      const entity = { id: 'uuid-1', name: 'BullMQ', type: 'technology', confidence: 0.9 }
      mockQuery.mockResolvedValueOnce({ rows: [entity] })

      const result = await store.getEntity('bullmq')

      expect(result).toEqual(entity)
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('LOWER(name) = LOWER($1)'),
        ['bullmq'],
      )
    })

    it('should return null when not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] })

      const result = await store.getEntity('nonexistent')

      expect(result).toBeNull()
    })
  })

  describe('applyConfidenceDecay', () => {
    it('should return number of decayed entities', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '5' }] })

      const result = await store.applyConfidenceDecay()

      expect(result).toBe(5)
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('GREATEST'),
        [0.95, 7, 0.1],
      )
    })

    it('should accept custom parameters', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '3' }] })

      await store.applyConfidenceDecay({ decayRate: 0.9, decayPeriodDays: 14, floor: 0.2 })

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('GREATEST'),
        [0.9, 14, 0.2],
      )
    })
  })

  describe('deprecateEntity', () => {
    it('should set confidence to 0.1 and add metadata', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 })

      const result = await store.deprecateEntity('old-tech', 'replaced')

      expect(result).toBe(true)
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('confidence = 0.1'),
        ['old-tech', expect.stringContaining('"deprecated":true')],
      )
    })

    it('should return false when entity not found', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 0 })

      const result = await store.deprecateEntity('nonexistent')

      expect(result).toBe(false)
    })
  })

  describe('pruneStale', () => {
    it('should delete low-confidence old entities', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '2' }] })

      const result = await store.pruneStale()

      expect(result).toBe(2)
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM kg_entities'),
        [0.15, 60],
      )
    })
  })

  describe('getStats', () => {
    it('should return counts', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '10' }] })
        .mockResolvedValueOnce({ rows: [{ count: '5' }] })

      const stats = await store.getStats()

      expect(stats).toEqual({ entities: 10, relations: 5 })
    })
  })
})
