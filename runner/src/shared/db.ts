import pg from 'pg'

export function createPool(overrides?: Partial<pg.PoolConfig>): pg.Pool {
  return new pg.Pool({
    host: process.env['PG_HOST'] ?? 'localhost',
    port: Number(process.env['PG_PORT'] ?? 5433),
    user: process.env['PG_USER'] ?? 'mindforge',
    password: process.env['PG_PASSWORD'] ?? 'mindforge123',
    database: process.env['PG_DATABASE'] ?? 'mindforge',
    max: 2,
    idleTimeoutMillis: 5000,
    connectionTimeoutMillis: 3000,
    ...overrides,
  })
}
