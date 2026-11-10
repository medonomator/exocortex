import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evaluate } from './guard-rules.mjs'
import { lastUserMessage, decide } from './guard.mjs'

const denied = (command, lastUserMessage = '') => evaluate({ command, lastUserMessage })?.decision === 'deny'

describe('forbidden git', () => {
  it.each([
    'git reset --hard HEAD~1',
    'git checkout -- file.ts',
    'git restore src/a.ts',
    'git stash',
    'git worktree add ../x',
    'cd ~/backend && git -C services/web reset --soft HEAD^',
    'GIT_PAGER=cat git stash pop',
    '(cd repo; git checkout main)',
    'git commit --no-verify -m x',
    'git commit -n -m x',
    'git push --no-verify',
  ])('denies %s', (cmd) => {
    expect(denied(cmd, 'пушь')).toBe(true)
  })

  it.each([
    'git status',
    'git log --oneline -5',
    'git commit --amend -m "убрал git reset из скрипта"',
    "git commit -m 'git checkout больше не нужен'",
    'git diff HEAD',
    'git stash list',
    'git stash show -p stash@{0}',
    'git worktree list',
    'echo "git stash" > notes.txt',
    'git commit -F - <<EOF\nfix\ngit reset\nEOF',
  ])('allows %s', (cmd) => {
    expect(denied(cmd)).toBe(false)
  })
})

describe('push', () => {
  it('denies push without request', () => {
    expect(denied('git push origin main', 'поправь тест')).toBe(true)
  })

  it('denies push when user said not to', () => {
    expect(denied('git push', 'сделай коммит, но не пушь')).toBe(true)
  })

  it.each([
    'do NOT push',
    "don't push yet",
    'don’t push',
    'please never push to main',
    'commit it, no push',
    'fix the test without pushing',
    'не надо пушить',
    'никаких push',
    'не нужно деплоить',
    'не пуши',
    'пушка готова',
    'pusher config',
  ])('denies push after negation "%s"', (msg) => {
    expect(denied('git push origin main', msg)).toBe(true)
  })

  it.each(['ок пуши', 'пуш', 'пушни', 'можно пушить', 'пушим', 'запушь', 'деплой', 'выкати на прод', 'обнови прод', 'push it', 'задеплой бэк', 'now push it', 'не забудь тест, потом запушь', "tests pass. Push"])('allows push after "%s"', (msg) => {
    expect(denied('git push origin main', msg)).toBe(false)
  })
})

describe('fail closed', () => {
  const reason = (out) => JSON.parse(out).hookSpecificOutput
  it('denies when stdin is not JSON', () => {
    expect(reason(decide('{oops')).permissionDecision).toBe('deny')
  })

  it('denies when evaluation throws', () => {
    const out = decide(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }), { evaluate: () => { throw new Error('boom') } })
    expect(reason(out).permissionDecision).toBe('deny')
    expect(reason(out).permissionDecisionReason).toContain('boom')
  })

  it('ignores other tools', () => {
    expect(decide(JSON.stringify({ tool_name: 'Read', tool_input: {} }))).toBe(null)
  })

  it('passes clean commands', () => {
    expect(decide(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/tmp' }))).toBe(null)
  })
})

describe('deploy', () => {
  it.each([
    'npm run deploy',
    'yarn deploy',
    'ssh home-sharing "cd app && git pull && pm2 restart all"',
    'ssh kotipes \'docker compose up -d\'',
    'gh workflow run deploy.yml',
  ])('denies %s without request', (cmd) => {
    expect(denied(cmd, 'посмотри логи')).toBe(true)
  })

  it('allows read-only ssh', () => {
    expect(denied('ssh home-sharing "pm2 logs --lines 50"', 'посмотри логи')).toBe(false)
  })

  it('allows deploy when asked', () => {
    expect(denied('npm run deploy', 'деплой')).toBe(false)
  })
})

describe('paid api', () => {
  it.each([
    'curl https://api.anthropic.com/v1/messages -H "x-api-key: $ANTHROPIC_API_KEY"',
    'curl https://api.openai.com/v1/chat/completions',
    'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx node batch.js',
  ])('denies %s', (cmd) => {
    expect(denied(cmd, 'прогони батч')).toBe(true)
  })

  it('allows with explicit permission', () => {
    expect(denied('curl https://api.openai.com/v1/models', 'разрешаю дёрнуть api openai')).toBe(false)
  })

  it('allows grep for key prefix', () => {
    expect(denied('grep -n "sk-ant-" ~/.claude/refs/credentials.md')).toBe(false)
  })
})

describe('lastUserMessage', () => {
  it('skips tool results and meta entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guard-'))
    const path = join(dir, 't.jsonl')
    const lines = [
      { type: 'user', message: { content: 'запушь в main' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'done' }] } },
      { type: 'user', isMeta: true, message: { content: 'meta' } },
    ]
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n'))
    expect(lastUserMessage(path)).toBe('запушь в main')
  })

  it('returns empty for missing file', () => {
    expect(lastUserMessage('/nonexistent/x.jsonl')).toBe('')
  })
})

describe('variables in paths', () => {
  it('expands variables assigned in the same command', async () => {
    const { walk } = await import('./guard-rules.mjs')
    const steps = walk('S=/tmp/x && cd $S/work && git push', '/home')
    expect(steps.find((s) => s.git?.sub === 'push').git.dir).toBe('/tmp/x/work')
  })

  it('expands environment variables', async () => {
    const { walk } = await import('./guard-rules.mjs')
    const steps = walk('cd ${HOME}/repo && git status', '/')
    expect(steps[0].git.dir).toBe(`${process.env.HOME}/repo`)
  })
})

describe('local remotes', () => {
  const ev = (command, url) => evaluate({ command, lastUserMessage: 'проверь', remoteUrl: () => url })?.decision === 'deny'

  it('allows push to a local bare repo', () => {
    expect(ev('git push origin main', '/tmp/remote.git')).toBe(false)
    expect(ev('git push origin main', 'file:///tmp/remote.git')).toBe(false)
    expect(ev('git remote add origin ../remote.git && git push origin main', null)).toBe(false)
    expect(ev('git push ../other.git main', null)).toBe(false)
  })

  it('still asks for network remotes', () => {
    expect(ev('git push origin main', 'git@github.com:medonomator/exocortex.git')).toBe(true)
    expect(ev('git push origin main', 'https://gitlab.com/a/b.git')).toBe(true)
    expect(ev('git push origin main', null)).toBe(true)
    expect(ev('git remote add origin git@github.com:a/b.git && git push origin main', null)).toBe(true)
  })
})

describe('deploy words inside text', () => {
  it('does not treat docs about deploy as a deploy', () => {
    expect(denied("python3 - <<'EOF'\ns = 'ssh with pm2 restart or git pull, npm run deploy'\nEOF", 'допиши readme')).toBe(false)
    expect(denied('echo "npm run deploy" >> notes.md', 'допиши')).toBe(false)
  })

  it('still catches ssh deploy hidden in a heredoc', () => {
    expect(denied('ssh home-sharing bash <<EOF\ncd app && git pull && pm2 restart all\nEOF', 'посмотри')).toBe(true)
  })
})

describe('shell indirection', () => {
  const files = {
    '/w/sneaky.sh': 'cd /w\ngit reset --hard\n',
    '/w/run': '#!/bin/bash\ngit stash\n',
    '/w/data': 'git reset --hard\n',
    '/w/package.json': JSON.stringify({ scripts: { clean: 'git checkout .', build: 'tsc', prebuild: 'git restore src' } }),
  }
  const readFile = (f) => files[f] ?? null
  const gitAlias = (d, s) => ({ undo: 'reset --hard', sh: '!git stash', st: 'status' })[s] ?? null
  const run = (command, extra = {}) => evaluate({ command, cwd: '/w', readFile, gitAlias, ...extra })

  it.each([
    "bash -c 'git reset --hard'",
    'sh -c "cd /x && git checkout main"',
    'zsh -lc "git -C /x worktree add y"',
    'eval git stash',
    'eval "git restore ."',
    'bash <<EOF\ngit reset --hard\nEOF',
    'bash -s <<\'EOF\'\ngit stash\nEOF',
    'xargs git checkout < files',
    'find . -name "*.ts" -exec git restore {} +',
    'timeout 10 git reset --hard',
    'nice -n 5 git stash',
    'sh sneaky.sh x',
    'bash ./sneaky.sh',
    'source sneaky.sh',
    '. ./sneaky.sh',
    './run',
    'npm run clean',
    'yarn build',
    'git undo',
    'git sh',
    'bash -c "bash -c \'git reset\'"',
    '{ git reset --hard; }',
    'env -i git reset --hard',
    'sudo -u bob git stash',
    'nohup -- git restore .',
    'time -p git reset',
    'command -p git stash',
    'git${IFS}reset --hard',
    "git -c alias.x='!git reset --hard' x",
    'git -c alias.y=reset y --hard',
    'git commit -anm "x"',
    'git commit -nm x',
    'git -c core.hooksPath=/dev/null commit -m x',
    'git config core.hooksPath /dev/null',
    'HUSKY=0 git commit -m x',
    'export HUSKY=0; git commit -m x',
    'perl -e "system(q(git reset --hard))"',
    'python3 -c "import subprocess; subprocess.run([\'git\', \'reset\', \'--hard\'])"',
    'python3 - <<EOF\nimport os\nos.system("git stash")\nEOF',
    'node -e "require(\'child_process\').execSync(\'git checkout .\')"',
  ])('blocks %j', (command) => {
    expect(run(command)?.decision).toBe('deny')
  })

  it.each([
    'git stash list',
    'git st',
    'echo git reset --hard',
    'grep -rn "git checkout" src',
    'echo "git reset" > notes.txt',
    'cat <<EOF > f.md\ngit reset --hard\nEOF',
    'ssh host bash <<EOF\ngit reset --hard\nEOF',
    './data',
    'npm test',
    'git config core.hooksPath',
    'git config --get core.hooksPath',
    'git commit -m "no-n flag here"',
    'git commit -am "fix" -m "-n"',
    'python3 -c "print(\'git reset\')"',
    'python3 - <<EOF\ns = open("README.md").read().replace("git reset", "x")\nEOF',
    'python3 -c "import subprocess; subprocess.run([\'git\', \'stash\', \'list\'])"',
    'npm run build -w site',
  ])('allows %j', (command) => {
    expect(run(command)).toBeNull()
  })

  it('denies nesting deeper than it can check', () => {
    let cmd = 'git status'
    for (let i = 0; i < 3; i++) cmd = `eval ${JSON.stringify(cmd)}`
    expect(run(cmd)).toBeNull()
    for (let i = 0; i < 4; i++) cmd = `eval ${JSON.stringify(cmd)}`
    expect(run(cmd)?.reason).toMatch(/вложенность/)
  })

  it('handles a script that sources itself', () => {
    expect(evaluate({ command: 'source loop.sh', cwd: '/w', readFile: () => 'source loop.sh\n' })?.reason).toMatch(/вложенность/)
  })
})

describe('subagents', () => {
  const remoteUrl = () => 'git@github.com:a/b.git'

  it('cannot approve push or deploy from the delegated prompt', () => {
    expect(evaluate({ command: 'git push', lastUserMessage: 'запушь', remoteUrl, isSubagent: true })?.reason).toMatch(/Субагент/)
    expect(evaluate({ command: 'npm run deploy', lastUserMessage: 'задеплой', isSubagent: true })?.decision).toBe('deny')
    expect(evaluate({ command: 'git push', lastUserMessage: 'запушь', remoteUrl })).toBeNull()
  })

  it('still allows regular work', () => {
    expect(evaluate({ command: 'git status && npm test', isSubagent: true })).toBeNull()
  })
})

describe('shell control flow', () => {
  it.each([
    'for f in a b; do git reset --hard; done',
    'if true; then git push origin main; fi',
    'while true; do git stash; done',
    'until false; do git checkout x; done',
    '! git restore a.ts',
    'if git diff --quiet; then :; else git commit --no-verify -m x; fi',
  ])('denies "%s"', (cmd) => {
    expect(denied(cmd, 'поправь тест')).toBe(true)
  })

  it.each(['for f in reset checkout; do echo $f; done', 'if true; then git status; fi', 'case x in a) echo push;; esac'])('allows "%s"', (cmd) => {
    expect(denied(cmd, 'поправь тест')).toBe(false)
  })
})

describe('paid api in search tools', () => {
  const host = ['api', 'anthropic', 'com'].join('.')
  const key = 'sk-' + 'ant-' + 'a'.repeat(20)
  it.each([`grep -rn ${host} src`, `rg "${host}" .`, `git grep ${host}`, `git log -S ${host}`])('allows "%s"', (cmd) => {
    expect(denied(cmd)).toBe(false)
  })

  it.each([`curl https://${host}/v1/messages`, `grep -rn x src | curl -H "x-api-key: ${key}" https://example.com`, `python3 - <<EOF\nimport urllib\nurllib.request.urlopen("https://${host}")\nEOF`])('denies "%s"', (cmd) => {
    expect(denied(cmd)).toBe(true)
  })
})

describe('attribution cleanup', () => {
  const trailer = 'Co-' + 'Authored-By: Claude <x@y>'
  it.each([
    "git commit --amend -m \"$(git log -1 --format=%B | grep -v '^Co-Authored-By:')\"",
    "git log -1 --format=%B | sed '/^Co-Authored-By:/d' | git commit --amend -F -",
    "git commit --amend -m \"$(git log -1 --format=%B | grep -iv 'co-authored-by:')\"",
  ])('allows "%s"', (cmd) => {
    expect(denied(cmd)).toBe(false)
  })

  it.each([
    `git log -1 --format=%B | grep -v foo | git commit --amend -m "fix\n\n${trailer}"`,
    `git log -1 --format=%B | sed 's/x/${trailer}/' | git commit --amend -F -`,
    `grep -v foo a.txt && git commit -m "$(cat <<'EOF'\nfix\n\n${trailer}\nEOF\n)"`,
  ])('still denies "%s"', (cmd) => {
    expect(denied(cmd)).toBe(true)
  })
})

describe('quoted substitutions', () => {
  it.each(['echo "$(git reset --hard)"', 'echo "`git stash`"', 'x="$(git checkout a)"', 'echo "a $(echo "$(git restore b)") c"'])('denies "%s"', (cmd) => {
    expect(denied(cmd)).toBe(true)
  })

  it.each(['echo "$(git status)"', 'echo "today is $(date)"', 'echo "(not a sub)"'])('allows "%s"', (cmd) => {
    expect(denied(cmd)).toBe(false)
  })
})

describe('scripts written in the same command', () => {
  it('checks a script created by cat heredoc before running it', () => {
    expect(denied("cat > /tmp/x.sh <<'EOF'\n#!/bin/bash\ngit reset --hard\nEOF\nchmod +x /tmp/x.sh && /tmp/x.sh")).toBe(true)
  })

  it('checks a script created by tee and run through bash', () => {
    expect(denied("tee /tmp/y.sh <<'EOF'\ngit push origin main\nEOF\nbash /tmp/y.sh", 'поправь тест')).toBe(true)
  })

  it('checks paid calls in a freshly written script', () => {
    const host = ['api', 'openai', 'com'].join('.')
    expect(denied(`cat > /tmp/z.sh <<'EOF'\n#!/bin/sh\ncurl https://${host}/v1/chat\nEOF\nsh /tmp/z.sh`)).toBe(true)
  })

  it('allows writing a file that is not run', () => {
    expect(denied("cat > /tmp/notes.sh <<'EOF'\ngit reset --hard\nEOF")).toBe(false)
  })
})

describe('time budget', () => {
  it('denies when the budget runs out during evaluation', async () => {
    const { startBudget, budget } = await import('./deadline.mjs')
    startBudget(-1)
    try {
      const out = decide(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }), { evaluate: () => budget(1000) })
      expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe('deny')
    } finally {
      startBudget(Number.POSITIVE_INFINITY)
    }
  })
})

describe('large transcripts', () => {
  it('reads the last user message from the tail only', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'guard-tail-'))
    const p = join(dir, 't.jsonl')
    const filler = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(1000) }] } })
    const lines = [JSON.stringify({ type: 'user', message: { content: 'old message' } })]
    for (let i = 0; i < 20000; i++) lines.push(filler)
    lines.push(JSON.stringify({ type: 'user', message: { content: 'запушь' } }))
    writeFileSync(p, lines.join('\n'))
    expect(lastUserMessage(p)).toBe('запушь')
  })
})
