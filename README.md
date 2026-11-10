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
- **Enforces guardrails.** Shell commands that rewrite git history, push, deploy or call paid APIs are blocked unless the user asked for them. Commits and PRs with AI attribution never leave the machine. Before the model reports back, the diff is checked for code comments, em dashes, secrets and unapplied migrations. See [Guardrails](#guardrails).

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
          |  hooks (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PreCompact, Stop)
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
| `guard.mjs` | PreToolUse (Bash) | Blocks forbidden git commands, unrequested push and deploy, paid API calls and AI attribution in commits and PRs |
| `bash-error-learner.mjs` | PostToolUse (Bash) | Surfaces known fixes for a failing command and stores new error/fix pairs |
| `git-commit-indexer.mjs` | PostToolUse (Bash) | Ingests each new commit as an episode |
| `guard-post.mjs` | PostToolUse (Bash) | Finds attribution in commits created in the last 15 minutes and tells the model to amend them |
| `file-context-hook.mjs` | PostToolUse (Read, Edit) | Recent history and related commits for the touched file |
| `pre-compact-checkpoint.mjs` | PreCompact | Marks the session in the graph before the transcript is compacted |
| `session-logger.mjs` | Stop | Tool usage and error telemetry for the observer |
| `stop-check.mjs` | Stop | Checks lines added this turn for comments, em dashes and secrets, and checks that new migrations were applied locally |

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
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "node /path/to/exocortex/hooks/guard.mjs", "timeout": 5 }]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "node /path/to/exocortex/hooks/bash-error-learner.mjs" },
          { "type": "command", "command": "node /path/to/exocortex/hooks/git-commit-indexer.mjs" },
          { "type": "command", "command": "node /path/to/exocortex/hooks/guard-post.mjs", "timeout": 5 }
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
      {
        "hooks": [
          { "type": "command", "command": "node /path/to/exocortex/hooks/session-logger.mjs" },
          { "type": "command", "command": "node /path/to/exocortex/hooks/stop-check.mjs", "timeout": 15 }
        ]
      }
    ],
    "SubagentStop": [
      {
        "hooks": [
          { "type": "command", "command": "node /path/to/exocortex/hooks/stop-check.mjs", "timeout": 15 }
        ]
      }
    ]
  },
  "attribution": { "commit": "", "pr": "", "sessionUrl": false }
}
```

The `attribution` block turns off Claude Code's own commit and PR trailers. The guard hooks below still catch attribution that gets in some other way.

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

## Guardrails

Rules in `CLAUDE.md` only work while the model remembers them. After a long session or a compaction they can drop out of context. The guard hooks take the critical rules out of the prompt and put them into code that runs on every tool call.

### Before a shell command

`guard.mjs` parses each Bash command with a small shell tokenizer. It follows `cd`, `git -C` and variables set in the same command. Text inside quotes and heredocs isn't treated as a command unless it goes to a shell. Command substitutions `$(...)` and backticks are checked even inside double quotes. Commands inside `if`, `while`, `until`, `for` and `case` are checked like any other command.

The parser also looks inside nested commands, up to four levels deep. That covers `bash -c`, `sh -c`, `eval`, a heredoc fed to `bash`, and git run through `xargs`, `find -exec`, `timeout`, `nice`, `env -i` or `sudo -u`. It reads scripts started with `sh script.sh`, `source` or `./script`. A script written by `cat > file <<EOF` or `tee` earlier in the same command is read from that heredoc. It also reads package scripts from `npm run`, `yarn` or `pnpm` including their `pre` and `post` hooks. Git aliases are resolved too, both from git config and from `git -c alias.x=...`. Inline code passed to `python -c`, `perl -e`, `node -e` and similar, or fed to them through a heredoc, is checked when it spawns a process. When nesting goes deeper than four levels, the command is denied, since it can't be checked. Commands run on another machine through ssh are left alone.

The hook denies the command when it finds any of these:

- `git reset`, `checkout`, `restore`, `stash` or `worktree`. Read-only `stash list`, `stash show` and `worktree list` pass.
- Skipping git hooks. That means `--no-verify`, `commit -n` (also inside `-anm`), `core.hooksPath` set through `-c` or `git config`, and `HUSKY=0` or similar variables.
- `git push` or a deploy. A deploy here means `npm run deploy`, `gh workflow run`, `vercel --prod`, or ssh that runs `pm2 restart`, `docker compose up`, `systemctl restart` or `git pull`. These pass only when the last user message asks for them. The approval words are Russian and English, such as "пушь", "деплой", "выкати", "push" or "deploy". A negation in the same clause counts as a refusal, in either language. So "не пушь", "не надо пушить", "do NOT push" and "commit it, no push" all block. A push to a remote that points at a local path needs no approval. Inside a subagent there's no approval at all. Its last user message is the prompt from the main agent, so only the main agent can push or deploy.
- Calls to the Anthropic or OpenAI API, or a literal `sk-*` key. These pass only after explicit permission in the last user message. Search and read tools like `grep`, `rg`, `cat`, `git grep` and `git log` are skipped, so looking for an API host in the code is fine.

The model gets the reason back and asks the user instead of retrying. If the hook itself crashes or gets input it can't parse, the command is denied. Claude Code lets a command run when a hook times out, so the guard has its own 8 second budget, under the 12 second hook timeout. When the budget runs out or a git call times out, the command is denied as well. Only the last 16 MB of the transcript is read, so a huge session doesn't slow it down.

### AI attribution

Attribution means a `Co-Authored-By` trailer, a `Claude-*` trailer, "Generated with Claude Code", a claude.ai link, the Anthropic noreply address or the robot emoji. The check normalizes Unicode first, so lookalike hyphens, fullwidth colons and zero-width characters don't get through. There are four layers.

1. The `attribution` setting stops Claude Code from adding its trailers.
2. `guard.mjs` scans the message of `git commit`, `tag`, `merge` and `notes`, and of `gh` and `glab` commands. That covers `-m`, heredocs, `--trailer` and the files passed with `-F` or `--body-file`.
3. `guard-post.mjs` runs after every Bash command. It looks at fresh commits in every repo the command touched, so it also catches a commit made by a script. The model is told to amend.
4. Before any `git push`, `guard.mjs` reads every commit that isn't on a remote yet. A dirty commit blocks the push. If the check itself fails, the push is blocked too.

An amend and a push in one command are checked against the state before the amend. Run them as two commands. Removing a trailer with `grep -v` or `sed '/.../d'` passes, since the pattern there is a filter and not part of the message.

### Before the model reports back

`stop-check.mjs` runs on Stop and on SubagentStop, so a subagent's work is checked before it reports to the main agent. It takes the files edited in the current turn and diffs them against the upstream merge base. Without an upstream it diffs against the last commit made before the turn, so lines committed during the turn still count. Only added lines are checked, so old code doesn't trigger it. Ignored files, files outside git and temp folders are skipped. Files changed through Bash count as well. The hook runs `git status` and reads the turn's commits in every repo the turn's commands touched. It picks the files modified after the user message.

| Check | Scope |
|-------|-------|
| Code comments | Comment syntax by file type (`//`, `/* */`, `#`, `--`). Directives like `eslint-disable`, `//go:embed`, `-- +goose`, `# type: ignore` and shebangs are allowed. Markdown and other prose files are skipped. |
| Em dash | Any text file |
| Secrets | Anthropic, OpenAI, GitHub, GitLab, Slack, AWS, Google, Telegram and Sentry tokens, private keys, passwords in connection strings |
| Migrations | A migration file created or edited this turn, by an edit tool or by a script, needs a successful migrate command after it (`go run ./cmd/migrate`, `make migrate`, `goose ... up`, `prisma migrate deploy`, `alembic upgrade` and similar). The word "migrate" in a grep or a path doesn't count |

When something is found, the model is sent back once with a list of `file:line` findings. On the second stop the hook stays quiet, so it can't loop. If the check itself fails or runs past its 12 second budget, the model is sent back once with a request to check the diff by hand. `guard-post.mjs` works the same way. When it can't read the fresh commits, it tells the model to look at `git log -1 --format=%B` itself.

### Known limits

- Deploy detection is pattern based. A custom script on the server won't be recognized.
- Approval comes from words in the last user message. A pasted log that contains "deploy" counts as approval.
- A paid API call from inside a script that reads its key from `.env` isn't visible in the command.
- Script files in other languages aren't parsed. A `script.py` that runs `git reset` through `subprocess` gets through. Inline code is checked, so a Python heredoc that only edits a file but mentions `subprocess` and `git reset` in its text is denied. Use the Edit tool for such changes.
- `gh pr create` and `glab mr create` are checked for attribution but don't need approval, even though they can push a branch.
- A Bash-changed file is matched by its modification time, so a file touched by a background process during the turn is checked too.
- Comment detection works line by line. A multiline template string that contains `//` can give a false positive.

Run the hook tests with `npx vitest run hooks/`.

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
