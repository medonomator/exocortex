#!/usr/bin/env tsx
/**
 * Migration runner for @exocortex/memory.
 *
 * Applies every *.sql file in this directory in lexicographic order.
 * Tracks applied migrations in mem_migrations table (created on first run).
 *
 * Usage:
 *   npm run migrate            # apply all pending
 *   npm run migrate -- --dry   # show which would run
 *   npm run migrate -- --reset # drop mem_* tables (DANGEROUS; dev only)
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PG = {
  host: process.env.PG_HOST ?? 'localhost',
  port: Number(process.env.PG_PORT ?? 5433),
  user: process.env.PG_USER ?? 'mindforge',
  password: process.env.PG_PASSWORD ?? 'mindforge123',
  database: process.env.PG_DATABASE ?? 'mindforge',
};

const ENSURE_TABLE = `
CREATE TABLE IF NOT EXISTS mem_migrations (
  filename    TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  checksum    TEXT NOT NULL
);
`;

function checksum(s: string): string {
  // simple non-crypto hash (deterministic, good enough for change detection)
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h.toString(16);
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const dry = args.has('--dry');
  const reset = args.has('--reset');

  const client = new Client(PG);
  await client.connect();

  if (reset) {
    const prompt =
      '⚠️  DROP all mem_* tables? Type YES to confirm via PG_RESET_CONFIRM env var.';
    if (process.env.PG_RESET_CONFIRM !== 'YES') {
      console.error(prompt);
      process.exit(1);
    }
    console.log('Dropping mem_* tables...');
    await client.query(`
      DROP VIEW IF EXISTS mem_items_all CASCADE;
      DROP VIEW IF EXISTS mem_items_compat_procedures CASCADE;
      DROP VIEW IF EXISTS mem_items_compat_entities CASCADE;
      DROP TABLE IF EXISTS mem_calibration CASCADE;
      DROP TABLE IF EXISTS mem_meta_snapshots CASCADE;
      DROP TABLE IF EXISTS mem_forgetting_log CASCADE;
      DROP TABLE IF EXISTS mem_lineage CASCADE;
      DROP TABLE IF EXISTS mem_events CASCADE;
      DROP TABLE IF EXISTS mem_items CASCADE;
      DROP TABLE IF EXISTS mem_migrations CASCADE;
      DROP TYPE IF EXISTS mem_item_type CASCADE;
      DROP TYPE IF EXISTS mem_lifecycle_status CASCADE;
      DROP TYPE IF EXISTS mem_event_kind CASCADE;
    `);
    console.log('Done.');
    await client.end();
    return;
  }

  await client.query(ENSURE_TABLE);
  const applied = new Set(
    (await client.query<{ filename: string }>('SELECT filename FROM mem_migrations')).rows.map(
      (r) => r.filename,
    ),
  );

  const files = (await readdir(__dirname))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`✓ ${file} (already applied)`);
      continue;
    }
    const path = join(__dirname, file);
    const sql = await readFile(path, 'utf8');
    const sum = checksum(sql);
    if (dry) {
      console.log(`→ ${file} (would apply, checksum ${sum})`);
      continue;
    }
    console.log(`→ ${file} (applying, checksum ${sum})`);
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO mem_migrations (filename, checksum) VALUES ($1, $2)', [
        file,
        sum,
      ]);
      await client.query('COMMIT');
      console.log(`✓ ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`✗ ${file} failed:`, err);
      throw err;
    }
  }

  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
