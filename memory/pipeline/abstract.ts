/**
 * abstract pipeline stage.
 *
 * Takes clusters from ClusterStage, asks an LLM to produce an abstraction
 * payload (title + summary + tags), and emits new MemoryItems at level+1.
 *
 * Cost control:
 *   - Runs on opus-4-7 for L2+ (strategic), sonnet-4-5 for L1 (tactical).
 *   - One LLM call per cluster; clusters below minSize were filtered upstream.
 *
 * Abstraction items have provenance.derivedFrom = [member ids] which is the
 * lineage edge used for root-cause traceback during introspection.
 */

import { randomUUID } from 'node:crypto';
import type { PipelineStage, StageContext, StageOutcome } from '../core/contracts.js';
import type {
  MemoryItem,
  AbstractionLevel,
  Confidence,
} from '../core/types.js';
import { Conf } from '../core/confidence.js';
import type { LLMProvider } from '../providers/llm.js';
import type { AbstractionPayload } from '../items/abstraction.js';
import { clustersByStageRun } from './cluster.js';

export interface AbstractStageOpts {
  llmStrategic: LLMProvider; // opus
  llmTactical: LLMProvider; // sonnet
  /** Source abstraction level (cluster members' level). Default 0. */
  sourceLevel?: AbstractionLevel;
  /** Initial importance for abstractions. Default 0.6. */
  importance?: number;
  /** Initial stability for abstractions. Default 30 days. */
  stabilityDays?: number;
}

interface AbstractionLLMOutput {
  title: string;
  summary: string;
  tags?: string[];
  cohesion?: number;
}

export class AbstractStage implements PipelineStage {
  readonly name = 'abstract';
  readonly version = '1.0.0';

  constructor(private readonly opts: AbstractStageOpts) {}

  async run(ctx: StageContext): Promise<StageOutcome> {
    const sourceLevel: AbstractionLevel = this.opts.sourceLevel ?? 0;
    const bundle = clustersByStageRun.get(ctx.now.getTime());
    if (!bundle) return { stage: this.name, items: ctx.items, stats: { abstracted: 0 } };
    clustersByStageRun.delete(ctx.now.getTime());

    const newItems: MemoryItem[] = [];
    const targetLevel: AbstractionLevel = Math.min(3, sourceLevel + 1) as AbstractionLevel;
    const useStrategic = targetLevel >= 2;
    const llm = useStrategic ? this.opts.llmStrategic : this.opts.llmTactical;

    for (const cluster of bundle.clusters) {
      const members = cluster.members
        .map((i) => bundle.eligible[i])
        .filter((m): m is MemoryItem => Boolean(m));
      if (members.length === 0) continue;
      const parsed = await askLLM(llm, members);
      if (!parsed) continue;

      const now = ctx.now;
      const payload: AbstractionPayload = {
        title: parsed.title.slice(0, 200),
        summary: parsed.summary.slice(0, 2000),
        childCount: members.length,
        cohesion: clamp01(parsed.cohesion ?? 0.7),
        tags: parsed.tags ?? [],
      };

      const conf: Confidence = seedConfidenceFromMembers(members);

      newItems.push({
        id: randomUUID(),
        type: 'abstraction',
        payload,
        raw: {
          text: `${payload.title}\n\n${payload.summary}`,
          contentType: 'text/markdown',
        },
        status: 'active',
        level: targetLevel,
        createdAt: now,
        updatedAt: now,
        lastAccessedAt: now,
        conf,
        stability: this.opts.stabilityDays ?? 30,
        importance: this.opts.importance ?? 0.6,
        accessCount: 0,
        provenance: {
          source: 'consolidate',
          producedAt: now,
          derivedFrom: members.map((m) => m.id),
          chain: ['cluster', 'abstract'],
          model: llm.defaultModel,
        },
        trainingEligible: false,
        metadata: {},
      });
    }

    return {
      stage: this.name,
      items: [...ctx.items, ...newItems],
      stats: { abstracted: newItems.length },
    };
  }
}

async function askLLM(
  llm: LLMProvider,
  members: MemoryItem[],
): Promise<AbstractionLLMOutput | null> {
  const bulleted = members
    .map((m, i) => `${i + 1}. ${m.raw.text.slice(0, 600)}`)
    .join('\n');

  const system =
    'You produce a concise abstraction over related memory items. ' +
    'Return strict JSON: {"title": string, "summary": string, "tags": string[], "cohesion": number}. ' +
    'cohesion in [0,1] reflects how tightly the items belong together; ' +
    'if they do not, set cohesion below 0.4 and keep the abstraction minimal.';

  const resp = await llm.complete({
    responseFormat: 'json',
    temperature: 0.2,
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: `Items to abstract:\n${bulleted}\n\nReturn JSON only.`,
      },
    ],
  });
  const parsed = resp.parsedJson as AbstractionLLMOutput | undefined;
  if (!parsed || typeof parsed.title !== 'string' || typeof parsed.summary !== 'string') {
    return null;
  }
  if (typeof parsed.cohesion === 'number' && parsed.cohesion < 0.4) return null;
  return parsed;
}

function seedConfidenceFromMembers(members: MemoryItem[]): Confidence {
  // Start from uniform prior, then fold in members' evidence bounded so one
  // noisy cluster can't dominate identity-level confidence.
  let c = Conf.uninformative();
  for (const m of members) {
    c = Conf.merge(c, m.conf);
  }
  // Soften: cap strength at member count so evidence doesn't explode.
  const cap = members.length + 1;
  const strength = Conf.strength(c);
  if (strength > cap) {
    const scale = cap / strength;
    c = { alpha: 1 + (c.alpha - 1) * scale, beta: 1 + (c.beta - 1) * scale };
  }
  return c;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}
