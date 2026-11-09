# Exocortex

[![CI](https://github.com/medonomator/exocortex/actions/workflows/ci.yml/badge.svg)](https://github.com/medonomator/exocortex/actions/workflows/ci.yml)

Long-term memory for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Exocortex plugs into Claude Code hooks, records what happens in your sessions and feeds the relevant parts back into the next prompt. Past decisions, error fixes, commits and file history show up in context without you asking for them.

## What it does

- **Recalls relevant memory on every prompt.** Hybrid retrieval combines vectors from Qdrant with lexical search and a knowledge graph in Postgres. Results are fused with RRF and scored by recency, importance and frequency. An LLM reranker runs last and can be switched off.
- **Learns from errors.** When a Bash command fails, the hook looks up similar past failures and injects the fix that worked last time.
- **Indexes git history.** Every commit becomes a memory item. Reading or editing a file pulls in its recent changes.
- **Forgets on purpose.** Items decay along an Ebbinghaus curve and get reinforced when recalled. Duplicates are merged, and contradicted facts are archived instead of piling up.
- **Builds a knowledge graph.** A nightly observer reads session transcripts and extracts projects, decisions, bugs and technologies. It also flags new decisions that contradict old ones.
- **Sends briefings.** A daily report and a morning summary go to Telegram.

## Example

You ask "SQLSTATE 40P01 in reconcileLedger again, how did we fix it last time?" in a `shop-api` session. Before the model sees the prompt, the recall hook adds this to its context:

```text
EXOCORTEX MEMORY RECALL:

SEMANTIC MEMORY (exocortex):
[Memory 1] (episode, shop-api, cosine: 0.676):
Fixed deadlock in reconcileLedger: two workers updated ledger_entries and account_balances in opposite order and Postgres aborted one with SQLSTATE 40P01. Both paths now lock account_balances first via SELECT ... FOR UPDATE ORDER BY account_id.

[Memory 2] (episode, shop-api, cosine: 0.562):
The nightly reconcileLedger cron took 47 minutes. Rewrote it to walk accounts in batches of 500 with a cursor and run 4 batches in parallel; it now finishes in 6 minutes.
```

The block comes from the synthetic eval corpus, not from real sessions. Reproduce it with `npm run eval -- --demo "<query>" --project shop-api`.

## Architecture

```
  Claude Code session
          |
          |  hooks (SessionStart, UserPromptSubmit, PostToolUse, PreCompact, Stop)
          |
  +-------+----------------------------------------------+
  |  hooks/            thin Node scripts, one per event  |
  +-------+----------------------------------------------+
          |
  +-------+----------------------------------------------+
  |  memory/           @exocortex/memory                 |
  |    ingest      novelty gate, provenance, lineage     |
  |    recall      vector + lexical + graph, RRF, rerank |
  |    consolidate clustering, abstraction ladder        |
  |    forget      decay, duplicate GC, tombstones       |
  +-------+-----------------------------+----------------+
          |                             |
     PostgreSQL                       Qdrant
   items, events, graph             embeddings
          |
  +-------+----------------------------------------------+
  |  runner/           scheduled jobs (cron / launchd)   |
  |    observer, consolidation, briefings, analytics     |
  +------------------------------------------------------+
```

### Packages

| Path | Purpose |
|------|---------|
| `memory/` | Core memory library. Typed items (episode, fact, relation, procedure, abstraction), pluggable ranking signals and lifecycle policies, SQL migrations. See [memory/README.md](memory/README.md). |
| `memory-graph/` | Knowledge graph store on Postgres with trigram matching and confidence decay. |
| `hooks/` | Claude Code hook entry points. Each one reads the hook payload from stdin and prints context for the model. |
| `runner/` | Batch jobs. Session observer, entity extraction, contradiction detection, graph consolidation, briefings, Langfuse tracing. Multi-agent analysis uses [cognitive-swarm](https://github.com/medonomator/cognitive-swarm). |

### Hooks

| Hook | Event | What it does |
|------|-------|--------------|
| `session-start-briefing.mjs` | SessionStart | Active work, recent decisions and open problems for the current project |
| `qdrant-recall.mjs` | UserPromptSubmit | Hybrid recall with HyDE for short queries, intent gating and LLM rerank |
| `bash-error-learner.mjs` | PostToolUse (Bash) | Surfaces known fixes for a failing command and stores new error/fix pairs |
| `git-commit-indexer.mjs` | PostToolUse (Bash) | Ingests each new commit as an episode |
| `file-context-hook.mjs` | PostToolUse (Read, Edit) | Recent history and related commits for the touched file |
| `pre-compact-checkpoint.mjs` | PreCompact | Marks the session in the graph before the transcript is compacted |
| `session-logger.mjs` | Stop | Tool usage and error telemetry for the observer |

## Getting started

You need Node.js 20+, Docker and an OpenAI API key for embeddings.

```bash
git clone https://github.com/medonomator/exocortex.git
cd exocortex
cp .env.example .env
npm run setup
npm run db:up
npm run db:init
npm run check
```

The repo is an npm workspace (`memory`, `memory-graph`, `runner`) with one lockfile at the root. `db:up` starts Postgres and Qdrant from `docker-compose.yml`. `db:init` applies the graph schema and the memory migrations. `check` runs the typecheck and the tests. The tests run against in-memory stores from `memory/testing/`, so they need neither Docker nor an API key.

### Connect Claude Code

Add the hooks to `~/.claude/settings.json`, using the absolute path to your clone:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "node /path/to/exocortex/hooks/session-start-briefing.mjs" }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node /path/to/exocortex/hooks/qdrant-recall.mjs" }] }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "node /path/to/exocortex/hooks/bash-error-learner.mjs" },
          { "type": "command", "command": "node /path/to/exocortex/hooks/git-commit-indexer.mjs" }
        ]
      },
      {
        "matcher": "Read|Edit",
        "hooks": [{ "type": "command", "command": "node /path/to/exocortex/hooks/file-context-hook.mjs" }]
      }
    ],
    "PreCompact": [
      { "hooks": [{ "type": "command", "command": "node /path/to/exocortex/hooks/pre-compact-checkpoint.mjs" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node /path/to/exocortex/hooks/session-logger.mjs" }] }
    ]
  }
}
```

If your repo folder names don't match the project names stored in memory, map them in `project-aliases.json`. See `project-aliases.example.json` for the format.

### Scheduled jobs

```bash
npm run observe:daily      # analyze the last 24h of sessions
npm run observe:swarm      # same analysis by a multi-agent cognitive-swarm debate
npm run briefing           # morning summary from the graph, no LLM calls
npm run consolidate        # merge duplicate entities, add shortcut relations
npm run swarm:analyze      # performance analysis of past swarm runs
```

The `runner/*.sh` wrappers are meant for cron or launchd. They load `.env`, write logs to `/tmp/exocortex-<job>.log` and send a Telegram alert if a job fails.

To index an existing repository's history:

```bash
node hooks/git-history-indexer.mjs --repo=/path/to/repo --since="6 months ago"
```

## Retrieval quality

`eval/` holds a labeled benchmark. It has 220 synthetic memories across five projects and 60 queries: keyword, paraphrase, short, multi-hop and out-of-scope. The corpus deliberately includes superseded decisions, near-miss incidents and rare exact tokens. The eval runs the real `RecallService` against in-memory stores and applies the same gate the hook uses.

| config | nDCG@10 | Recall@5 | MRR@10 |
|---|---|---|---|
| vector only | 0.898 | 0.920 | 0.915 |
| hybrid (RRF, all signals) | 0.898 | 0.920 | 0.915 |
| hybrid + HyDE | 0.901 | 0.921 | 0.931 |
| hybrid + rerank | 0.944 | 0.950 | 0.966 |
| hybrid + HyDE + rerank | 0.953 | 0.957 | 0.966 |

The LLM rerank gives the biggest gain, mostly on paraphrased questions (nDCG 0.877 to 0.967). HyDE only helps short queries. Full tables, per-kind breakdown and gate counts are in [eval/results.md](eval/results.md).

The benchmark also exposed two weak spots. They're left as is for now, so the numbers above describe the current behavior:

- The lexical arm uses `plainto_tsquery('simple')`, which requires every word of the prompt to match. It returned anything for 2 of 52 queries, so hybrid scores the same as vector only. An OR query or BM25 over content words should fix that.
- The hook's gate (top-1 cosine 0.55) is strict for `text-embedding-3-small`. It stays silent on all 8 out-of-scope queries. It also stays silent on 30 of the 52 answerable ones, even though the right memory is usually ranked first.

```bash
npm run eval:offline   # hash embeddings, no network, runs in CI
npm run eval           # OpenAI embeddings plus gpt-4o-mini, a few cents, cached in eval/.cache
```

The lexical arm is emulated in-process with the same AND semantics as Postgres, so the eval needs no database.

## Configuration

Everything is set through `.env`. The main variables are listed in [.env.example](.env.example). Recall can be tuned with these:

| Variable | Default | Effect |
|----------|---------|--------|
| `EXOCORTEX_HYDE` | on, `0` disables | Hypothetical document embedding for short queries |
| `EXOCORTEX_LLM_RERANK` | on, `0` disables | Listwise rerank of the top results |
| `EXOCORTEX_MIN_COSINE` | `0.50` | Minimum vector similarity to keep a hit |
| `EXOCORTEX_EMBED_MODEL` | `text-embedding-3-small` | Embedding model |

## License

[MIT](LICENSE)
