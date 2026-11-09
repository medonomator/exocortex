#!/usr/bin/env tsx
/**
 * CLI entry: nightly/weekly forgetting pass.
 *
 * Usage:
 *   tsx memory/bin/forget.ts [--dry] [--policy=name,...] [--now=ISO]
 *
 * Called from cron:
 *   nightly (default order minus duplicate-gc)
 *   weekly  (--policy=duplicate-gc,core-promotion)
 */

import { PostgresStore } from '../stores/postgres.js';
import { QdrantStore } from '../stores/qdrant.js';
import { OpenAIEmbedder } from '../stores/embedder.js';
import { PluginRegistry } from '../core/registry.js';
import type { Policy } from '../core/contracts.js';
import {
  DecayEbbinghausPolicy,
  ContradictionArchivePolicy,
  CorePromotionPolicy,
  ExplicitTombstonePolicy,
  DuplicateGcPolicy,
} from '../policies/index.js';
import { ForgetService, DEFAULT_FORGET_ORDER } from '../services/forget.js';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = Boolean(args.dry);
  const now = args.now ? new Date(String(args.now)) : new Date();
  const policies = args.policy ? String(args.policy).split(',').map((s) => s.trim()) : undefined;

  const pg = new PostgresStore();
  const qd = new QdrantStore({
    collection: process.env.QDRANT_COLLECTION ?? 'mem_items_3small',
    vectorSize: Number(process.env.EMBEDDING_DIM ?? 1536),
  });
  const embedder = new OpenAIEmbedder({
    apiKey: process.env.OPENAI_API_KEY ?? '',
    model: 'text-embedding-3-small',
  });

  const registry = new PluginRegistry<Policy>('policy')
    .register(new DecayEbbinghausPolicy(pg))
    .register(new ContradictionArchivePolicy(pg))
    .register(new CorePromotionPolicy(pg))
    .register(new ExplicitTombstonePolicy(pg))
    .register(new DuplicateGcPolicy(pg, qd, embedder));

  const svc = new ForgetService({ registry });

  try {
    const res = await svc.run({ policies: policies ?? DEFAULT_FORGET_ORDER, dryRun, now });
    console.log(JSON.stringify(res, null, 2));
  } finally {
    await pg.close();
  }
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const [k, v] = a.slice(2).split('=', 2);
    if (k) out[k] = v ?? true;
  }
  return out;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
