import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findComment, findSecret, analyzeAddedLines, pendingMigrations, isMigrationFile } from './stop-check-rules.mjs'
import { parseTranscript, parseUnifiedDiff, addedLines, check, decideStop } from './stop-check.mjs'

const DASH = String.fromCharCode(0x2014)

describe('findComment', () => {
  it.each([
    ['a.ts', '// fetch user'],
    ['a.ts', 'const x = 1 // why'],
    ['a.ts', '/** JSDoc */'],
    ['a.ts', ' * @param x'],
    ['a.go', '\t// Handler does things'],
    ['a.swift', '/// Doc comment'],
    ['a.swift', '// MARK: - View'],
    ['a.py', '# compute'],
    ['a.py', 'x = 1  # inline'],
    ['a.yml', 'key: value # note'],
    ['Dockerfile', '# build stage'],
    ['a.sql', '-- add index'],
    ['a.css', '/* header */'],
    ['a.go', 'x := 1 // TODO JIRA-123'],
  ])('flags %s %j', (path, line) => {
    expect(findComment(path, line, 5)).toBe(true)
  })

  it.each([
    ['a.ts', 'const url = "https://example.com"'],
    ['a.ts', "fetch('http://localhost:3000')"],
    ['a.ts', 'const re = `// not a comment`'],
    ['a.ts', '// eslint-disable-next-line no-console'],
    ['a.ts', '// @ts-expect-error'],
    ['a.go', '//go:embed migrations/*.sql'],
    ['a.go', '//nolint:errcheck'],
    ['a.sql', '-- +goose Up'],
    ['a.sql', '-- +goose StatementBegin'],
    ['a.sh', 'echo "${#arr[@]}"'],
    ['a.sh', 'echo $#'],
    ['a.py', 'print("#hashtag")'],
    ['a.py', 'x = 1  # type: ignore'],
    ['a.rs', '#[derive(Debug)]'],
    ['a.md', '# Header'],
    ['a.json', '{"a": "// b"}'],
    ['a.ts', 'const a = b * c'],
  ])('ignores %s %j', (path, line) => {
    expect(findComment(path, line, 5)).toBe(false)
  })

  it('ignores shebang on first line', () => {
    expect(findComment('a.sh', '#!/bin/sh', 1)).toBe(false)
  })
})

describe('findSecret', () => {
  it.each([
    'const k = "sk-ant-' + 'a'.repeat(40) + '"',
    'OPENAI=sk-proj-' + 'b'.repeat(40),
    'token: ghp_' + 'c'.repeat(36),
    'glpat-' + 'd'.repeat(20),
    'AKIA' + 'ABCDEFGHIJKLMNOP',
    'BOT=1234567890:AA' + 'e'.repeat(33),
    '-----BEGIN OPENSSH ' + 'PRIVATE KEY-----',
    'DATABASE_URL=postgres://app:' + 'hunter2' + '@localhost:5432/db',
  ])('finds %s', (line) => {
    expect(findSecret(line)).not.toBeNull()
  })

  it.each([
    'DATABASE_URL=postgres://app:${DB_PASSWORD}@localhost/db',
    'url: postgres://user:<password>@host/db',
    'const key = process.env.ANTHROPIC_API_KEY',
    'grep -n "sk-ant-" credentials.md',
  ])('ignores %s', (line) => {
    expect(findSecret(line)).toBeNull()
  })
})

describe('analyzeAddedLines', () => {
  it('flags em dash in prose and code but not comments in markdown', () => {
    const issues = analyzeAddedLines('README.md', [{ line: 3, text: `Guard ${DASH} это хук` }, { line: 4, text: '# Заголовок' }])
    expect(issues.map((i) => i.kind)).toEqual(['длинное тире'])
  })

  it('masks secrets in the report', () => {
    const [issue] = analyzeAddedLines('a.ts', [{ line: 1, text: 'k = "sk-ant-' + 'x'.repeat(40) + '"' }])
    expect(issue.text).not.toContain('x'.repeat(20))
  })
})

describe('migrations', () => {
  it('detects migration paths', () => {
    expect(isMigrationFile('/b/services/blog/migrations/00003_x.sql')).toBe(true)
    expect(isMigrationFile('/b/services/blog/migrations/embed.go')).toBe(false)
    expect(isMigrationFile('/b/services/blog/cmd/migrate/main.go')).toBe(false)
  })

  const edit = { kind: 'edit', path: '/b/services/blog/migrations/00003_x.sql' }

  it('reports migration written this turn without apply', () => {
    expect(pendingMigrations([edit], 0)).toEqual([edit.path])
  })

  it('accepts successful migrate after the edit', () => {
    const events = [edit, { kind: 'bash', command: 'cd services/blog && go run ./cmd/migrate -command=up', ok: true }]
    expect(pendingMigrations(events, 0)).toEqual([])
  })

  it('rejects failed migrate or migrate before the last edit', () => {
    expect(pendingMigrations([edit, { kind: 'bash', command: 'make migrate', ok: false }], 0)).toEqual([edit.path])
    expect(pendingMigrations([{ kind: 'bash', command: 'make migrate', ok: true }, edit], 0)).toEqual([edit.path])
  })

  it.each([
    'grep -rn migrate services',
    'ls services/blog/cmd/migrate',
    'cat services/blog/cmd/migrate/main.go',
    'echo "migrate later"',
    'git commit -m "добавил migrate"',
  ])('does not treat "%s" as applying migrations', (command) => {
    expect(pendingMigrations([edit, { kind: 'bash', command, ok: true }], 0)).toEqual([edit.path])
  })

  it.each([
    'make migrate',
    'make -C services/blog migrate-up',
    'migrate -path db -database x up',
    './bin/migrate up',
    'goose postgres x up',
    'npm run migrate',
    'yarn db:migrate',
    'npx prisma migrate deploy',
    'alembic upgrade head',
    'python manage.py migrate',
    'psql -d app -f migrations/001.sql',
    'DATABASE_URL=x go run ./cmd/migrate -command=up',
  ])('treats "%s" as applying migrations', (command) => {
    expect(pendingMigrations([edit, { kind: 'bash', command, ok: true }], 0)).toEqual([])
  })

  it('ignores migrations from earlier turns', () => {
    expect(pendingMigrations([edit, { kind: 'edit', path: '/b/a.go' }], 1)).toEqual([])
  })
})

const entry = (type, content, extra = {}) => JSON.stringify({ type, message: { content }, ...extra })

describe('parseTranscript', () => {
  it('splits turns and pairs bash results', () => {
    const raw = [
      entry('user', 'first'),
      entry('assistant', [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/a.ts' } }]),
      entry('user', 'second'),
      entry('assistant', [{ type: 'tool_use', id: 't2', name: 'Write', input: { file_path: '/b.ts' } }, { type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'make migrate' } }]),
      entry('user', [{ type: 'tool_result', tool_use_id: 't3', is_error: true, content: 'boom' }]),
    ].join('\n')
    const { events, turnStart } = parseTranscript(raw)
    expect(turnStart).toBe(1)
    expect(events[1]).toMatchObject({ kind: 'edit', path: '/b.ts' })
    expect(events[2].ok).toBe(false)
  })
})

describe('parseUnifiedDiff', () => {
  it('tracks added line numbers', () => {
    const diff = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,0 +2,2 @@\n+one\n+two\n@@ -10 +12 @@\n-old\n+new'
    expect(parseUnifiedDiff(diff)).toEqual([{ line: 2, text: 'one' }, { line: 3, text: 'two' }, { line: 12, text: 'new' }])
  })
})

describe('real git repo', () => {
  it('checks only lines added since base and skips ignored files', () => {
    const repo = mkdtempSync(join(tmpdir(), 'stop-check-'))
    const g = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' })
    execFileSync('git', ['init', '-q', '-b', 'main', repo])
    g('config', 'user.email', 't@t')
    g('config', 'user.name', 't')
    writeFileSync(join(repo, 'a.ts'), '// old comment by someone\nconst a = 1\n')
    writeFileSync(join(repo, '.gitignore'), 'secret.ts\n')
    g('add', '.')
    g('commit', '-qm', 'init')
    writeFileSync(join(repo, 'a.ts'), '// old comment by someone\nconst a = 1\nconst b = 2 // new\n')
    writeFileSync(join(repo, 'new.ts'), `export const t = "a ${DASH} b"\n`)
    writeFileSync(join(repo, 'secret.ts'), '// ignored\n')

    expect(addedLines(join(repo, 'a.ts'))).toEqual([{ line: 3, text: 'const b = 2 // new' }])
    expect(addedLines(join(repo, 'secret.ts'))).toBeNull()

    const raw = [
      entry('user', 'go'),
      entry('assistant', ['a.ts', 'new.ts', 'secret.ts'].map((f, i) => ({ type: 'tool_use', id: `t${i}`, name: 'Edit', input: { file_path: join(repo, f) } }))),
    ].join('\n')
    const report = check(raw)
    expect(report).toMatch(/a\.ts:3 комментарий/)
    expect(report).toMatch(/new\.ts:1 длинное тире/)
    expect(report).not.toMatch(/old comment|secret\.ts/)
  })

  it('returns null when everything is clean', () => {
    const raw = [entry('user', 'go'), entry('assistant', [{ type: 'text', text: 'ok' }])].join('\n')
    expect(check(raw)).toBeNull()
  })
})

describe('files changed through Bash', () => {
  const at = (iso, type, content, extra = {}) => JSON.stringify({ type, timestamp: iso, message: { content }, ...extra })

  it('scans files written by a script and requires migrate after them', () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'stop-bash-')))
    const g = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' })
    execFileSync('git', ['init', '-q', '-b', 'main', repo])
    g('config', 'user.email', 't@t')
    g('config', 'user.name', 't')
    writeFileSync(join(repo, 'a.go'), 'package a\n')
    g('add', '.')
    g('commit', '-qm', 'init')
    const start = new Date(Date.now() - 5000).toISOString()
    mkdirSync(join(repo, 'migrations'))
    writeFileSync(join(repo, 'a.go'), 'package a\n\nvar x = 1 // sneaky\n')
    writeFileSync(join(repo, 'migrations', '00002_x.sql'), '-- +goose Up\nCREATE TABLE t (id int);\n')
    const later = new Date(Date.now() + 5000).toISOString()
    const raw = [
      at(start, 'user', 'go'),
      at(start, 'assistant', [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: `python3 gen.py ${repo}` } }], { cwd: repo }),
      at(start, 'user', [{ type: 'tool_result', tool_use_id: 'b1', content: 'ok' }]),
    ]
    const report = check(raw.join('\n'))
    expect(report).toMatch(/a\.go:3 комментарий/)
    expect(report).toMatch(/00002_x\.sql новая миграция не накатана/)

    raw.push(
      at(later, 'assistant', [{ type: 'tool_use', id: 'b2', name: 'Bash', input: { command: 'go run ./cmd/migrate -command=up' } }], { cwd: repo }),
      at(later, 'user', [{ type: 'tool_result', tool_use_id: 'b2', content: 'ok' }]),
    )
    expect(check(raw.join('\n'))).not.toMatch(/миграция/)
  })

  it('scans a file that a script changed and committed in the same turn', () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'stop-commit-')))
    const g = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' })
    execFileSync('git', ['init', '-q', '-b', 'main', repo])
    g('config', 'user.email', 't@t')
    g('config', 'user.name', 't')
    writeFileSync(join(repo, 'a.ts'), 'export const a = 1\n')
    g('add', '.')
    g('commit', '-qm', 'init')
    const start = new Date(Date.now() - 3000).toISOString()
    writeFileSync(join(repo, 'b.ts'), 'export const b = 2 // sneaky\n')
    g('add', '.')
    g('commit', '-qm', 'more')
    const raw = [
      at(start, 'user', 'go'),
      at(start, 'assistant', [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'sh gen.sh && git commit -am x' } }], { cwd: repo }),
    ].join('\n')
    expect(check(raw)).toMatch(/b\.ts:1 комментарий/)
  })

  it('ignores files untouched since the turn started', () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'stop-old-')))
    execFileSync('git', ['init', '-q', '-b', 'main', repo])
    writeFileSync(join(repo, 'old.ts'), 'const a = 1 // old\n')
    const future = new Date(Date.now() + 60000).toISOString()
    const raw = [
      at(future, 'user', 'go'),
      at(future, 'assistant', [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'ls' } }], { cwd: repo }),
    ].join('\n')
    expect(check(raw)).toBeNull()
  })
})

describe('stop-check failures', () => {
  const input = (extra = {}) => JSON.stringify({ transcript_path: '/t.jsonl', ...extra })

  it('blocks once when the check crashes', () => {
    const out = decideStop(input(), { read: () => '', check: () => { throw new Error('boom') } })
    expect(JSON.parse(out).decision).toBe('block')
    expect(JSON.parse(out).reason).toContain('boom')
  })

  it('stays quiet on the second stop', () => {
    expect(decideStop(input({ stop_hook_active: true }), { check: () => { throw new Error('boom') } })).toBe(null)
  })

  it('stays quiet when the transcript is clean', () => {
    expect(decideStop(input(), { read: () => '', check: () => null })).toBe(null)
  })

  it('stays quiet when the transcript file is missing', () => {
    expect(decideStop(input())).toBe(null)
  })

  it('does not block on broken stdin to avoid loops', () => {
    expect(decideStop('{oops')).toBe(null)
  })
})
