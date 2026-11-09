# @exocortex/memory

Cognitive Memory System v2 - layered persistent memory for Exocortex.

## Architecture

Five fundamental abstractions:

1. **MemoryEvent** - atomic input (session-turn, observation, error, commit, message)
2. **MemoryItem<T>** - universal stored cell (episode / fact / relation / procedure / abstraction)
3. **Five primitive operations** - `ingest`, `recall`, `consolidate`, `forget`, `introspect`
4. **Three plugin registries** - signals (ranking), policies (lifecycle), pipeline (consolidate)
5. **Provenance** - first-class metadata with derivedFrom causal lineage

## Layers

- **Working** (Redis TTL 24h) - ephemeral context
- **Episodic** (Postgres) - time-stamped events, decay by Ebbinghaus
- **Semantic** (Postgres) - consolidated facts, slower decay, core-promoted
- **Procedural** (Postgres) - "when X do Y" patterns with success tracking
- **Abstraction** (Postgres) - L1/L2/L3 summaries of clustered items

Embeddings live in Qdrant; structured data in Postgres. Cross-referenced by item id.

## Mathematical primitives

- **Beta confidence** `{alpha, beta}` instead of scalar - allows evidence accumulation
- **Ebbinghaus lazy decay** on-read: `stability *= 1 + log(1+gap)` on reactivation
- **Lifecycle states** (active / decayed / archived / tombstoned) orthogonal to confidence
- **Multi-signal ranking** with explicit breakdown for learning-to-rank later
- **Dual retrieval** vector + lexical (tsvector BM25) via RRF
- **Novelty gate** prevents duplicate bloat (KL-approx via `1 - maxSim`)
- **Provenance chains** track derivedFrom for causal analysis

## Phases

- Phase 1: Universal schema + ingest
- Phase 2: Forgetting engine + lifecycle
- Phase 3: Multi-signal retrieval bus
- Phase 4: Abstraction ladder L0-L3
- Phase 5: Meta-memory + fine-tune readiness
