/**
 * MemoryFacade - composes the five services behind the Memory interface.
 *
 * Thin. Does not own state. Instantiated once at bootstrap and passed as the
 * single entrypoint to hooks, CLI, cron jobs.
 */

import type { Memory, MemoryIntrospect } from '../core/memory.js';
import type {
  MemoryEvent,
  Query,
  RecallResult,
  IngestResult,
  ConsolidateResult,
  ForgetPolicy,
  ForgetResult,
  TimeRange,
} from '../core/types.js';
import type { IngestService, IngestHint } from './ingest.js';
import type { RecallService, RecallOpts } from './recall.js';
import type { ConsolidateService } from './consolidate.js';
import type { ForgetService } from './forget.js';
import type { IntrospectService } from './introspect.js';

export interface MemoryFacadeOpts {
  ingestSvc: IngestService;
  recallSvc: RecallService;
  consolidateSvc: ConsolidateService;
  forgetSvc: ForgetService;
  introspectSvc: IntrospectService;
}

export class MemoryFacade implements Memory {
  constructor(private readonly svc: MemoryFacadeOpts) {}

  ingest(event: MemoryEvent, hint: IngestHint = {}): Promise<IngestResult> {
    return this.svc.ingestSvc.ingest(event, hint);
  }

  recall(query: Query, opts: RecallOpts = {}): Promise<RecallResult> {
    return this.svc.recallSvc.recall(query, opts);
  }

  async consolidate(window?: TimeRange): Promise<ConsolidateResult> {
    return this.svc.consolidateSvc.run({ window });
  }

  async forget(policy: ForgetPolicy): Promise<ForgetResult> {
    const started = Date.now();
    const res = await this.svc.forgetSvc.run({
      policies: [policy.name],
      configs: policy.config ? { [policy.name]: policy.config } : undefined,
    });
    const outcome = res.outcomes[0];
    const transitions = outcome?.transitions ?? {};
    return {
      policy: policy.name,
      itemsAffected: outcome?.itemsAffected ?? 0,
      itemsArchived: transitions.archived ?? 0,
      itemsTombstoned: transitions.tombstoned ?? 0,
      elapsedMs: Date.now() - started,
    };
  }

  introspect(): MemoryIntrospect {
    return this.svc.introspectSvc;
  }
}
