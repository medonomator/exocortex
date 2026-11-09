#!/usr/bin/env tsx
/**
 * CLI: mark an item as human-approved or human-corrected.
 *
 * Usage:
 *   tsx memory/bin/approve.ts <itemId>
 *   tsx memory/bin/approve.ts <itemId> --correct "replacement text"
 *
 * Sets humanApproved=true (or humanCorrected=...) and trainingEligible=true,
 * so the item will be included in fine-tune exports.
 */

import { PostgresStore } from '../stores/postgres.js';
import { Conf } from '../core/confidence.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const id = args[0];
  if (!id) {
    console.error('Usage: approve.ts <itemId> [--correct "..."]');
    process.exit(1);
  }
  const correctFlagIdx = args.indexOf('--correct');
  const correction = correctFlagIdx >= 0 ? args[correctFlagIdx + 1] : undefined;

  const pg = new PostgresStore();
  try {
    const item = await pg.getItem(id);
    if (!item) {
      console.error(`Item ${id} not found`);
      process.exit(1);
    }

    const patch: Parameters<PostgresStore['patchItem']>[1] = {
      trainingEligible: true,
    };

    if (correction) {
      patch.humanCorrected = correction;
      // Correction implies one contradictory vote on the original, plus we
      // retain the item for DPO training.
      patch.conf = Conf.contradict(item.conf, 1);
    } else {
      patch.humanApproved = true;
      patch.conf = Conf.reinforce(item.conf, 2);
    }

    await pg.patchItem(id, patch);
    console.log(
      JSON.stringify(
        { id, action: correction ? 'corrected' : 'approved', conf: patch.conf },
        null,
        2,
      ),
    );
  } finally {
    await pg.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
