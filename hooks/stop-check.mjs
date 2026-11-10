#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readStdinSync } from './utils.mjs'
import { analyzeAddedLines, formatReport, pendingMigrations } from './stop-check-rules.mjs'
import { walk } from './guard-rules.mjs'
import { budget, isTimeout, readTail, startBudget } from './deadline.mjs'

const BUDGET_MS = 12000
const TRANSCRIPT_TAIL_BYTES = 32_000_000

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const MAX_FILE_BYTES = 2_000_000

function isRealUserMessage(entry) {
  if (entry.type !== 'user' || entry.isMeta) return false
  const c = entry.message?.content
  if (typeof c === 'string') return !c.startsWith('<command-') && !c.startsWith('<local-command') && c.trim() !== ''
  if (!Array.isArray(c)) return false
  return !c.some((b) => b?.type === 'tool_result') && c.some((b) => b?.type === 'text' && b.text.trim())
}

export function parseTranscript(raw) {
  const events = []
  const pending = new Map()
  let turnStart = 0
  let turnStartTime = 0
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const time = Date.parse(entry.timestamp ?? '') || 0
    if (isRealUserMessage(entry)) {
      turnStart = events.length
      turnStartTime = time
      continue
    }
    const content = entry.message?.content
    if (!Array.isArray(content)) continue
    for (const b of content) {
      if (b?.type === 'tool_use' && EDIT_TOOLS.has(b.name)) {
        const path = b.input?.file_path ?? b.input?.notebook_path
        if (path) events.push({ kind: 'edit', path, time })
      } else if (b?.type === 'tool_use' && b.name === 'Bash') {
        const e = { kind: 'bash', command: b.input?.command ?? '', ok: false, time, cwd: entry.cwd ?? null }
        pending.set(b.id, e)
        events.push(e)
      } else if (b?.type === 'tool_result' && pending.has(b.tool_use_id)) {
        pending.get(b.tool_use_id).ok = b.is_error !== true
      }
    }
  }
  return { events, turnStart, turnStartTime }
}

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf-8', timeout: budget(4000), maxBuffer: 50_000_000, stdio: ['ignore', 'pipe', 'ignore'] })
}

function tryGit(dir, args) {
  try {
    return git(dir, args)
  } catch (e) {
    if (isTimeout(e)) throw e
    return null
  }
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

function diffBase(top, turnStartTime = 0) {
  const upstream = tryGit(top, ['rev-parse', '--verify', '--quiet', '@{u}'])
  if (upstream) {
    const base = tryGit(top, ['merge-base', 'HEAD', '@{u}'])
    if (base) return base.trim()
  }
  if (!tryGit(top, ['rev-parse', '--verify', '--quiet', 'HEAD'])) return EMPTY_TREE
  if (!turnStartTime) return 'HEAD'
  const before = tryGit(top, ['rev-list', '-1', `--before=@${Math.floor(turnStartTime / 1000)}`, 'HEAD'])?.trim()
  return before || EMPTY_TREE
}

export function parseUnifiedDiff(diff) {
  const added = []
  let line = 0
  for (const l of diff.split('\n')) {
    const hunk = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunk) {
      line = Number(hunk[1])
      continue
    }
    if (l.startsWith('+++') || l.startsWith('---')) continue
    if (l.startsWith('+')) added.push({ line: line++, text: l.slice(1) })
    else if (!l.startsWith('-') && !l.startsWith('\\')) line++
  }
  return added
}

export function addedLines(inputPath, turnStartTime = 0) {
  if (!existsSync(inputPath)) return null
  const path = realpathSync(inputPath)
  if (statSync(path).isDirectory() || statSync(path).size > MAX_FILE_BYTES) return null
  const top = tryGit(dirname(path), ['rev-parse', '--show-toplevel'])?.trim()
  if (!top) return null
  const rel = relative(top, path)
  if (tryGit(top, ['check-ignore', '-q', '--', rel]) !== null) return null
  const tracked = tryGit(top, ['ls-files', '--error-unmatch', '--', rel]) !== null
  if (!tracked) {
    const text = readFileSync(path, 'utf-8')
    if (text.includes('\0')) return null
    return text.split('\n').map((t, i) => ({ line: i + 1, text: t }))
  }
  const base = diffBase(top, turnStartTime)
  const diff = tryGit(top, ['diff', '-U0', '--no-color', '--no-ext-diff', base, '--', rel])
  return diff ? parseUnifiedDiff(diff) : []
}

export function bashTouchedFiles(events, turnStart, turnStartTime) {
  if (!turnStartTime) return []
  const repos = new Set()
  for (const e of events.slice(turnStart)) {
    if (e.kind !== 'bash') continue
    const dirs = new Set(e.cwd ? [e.cwd] : [])
    try {
      for (const step of walk(e.command, e.cwd ?? process.cwd())) {
        dirs.add(step.git?.dir ?? step.dir)
        for (const tok of step.tokens.slice(1)) if (tok.startsWith('/') || tok.startsWith('~')) dirs.add(dirname(tok.replace(/^~/, process.env.HOME ?? '~')))
      }
    } catch {}
    for (const d of dirs) {
      if (!d || !existsSync(d)) continue
      const top = tryGit(d, ['rev-parse', '--show-toplevel'])?.trim()
      if (top) repos.add(top)
      if (repos.size >= 12) break
    }
  }
  const files = new Map()
  const since = `@${Math.floor(turnStartTime / 1000) - 1}`
  for (const top of repos) {
    const rels = []
    const status = tryGit(top, ['status', '--porcelain', '-z', '--untracked-files=all']) ?? ''
    const entries = status.split('\0')
    for (let i = 0; i < entries.length; i++) {
      const rec = entries[i]
      if (rec.length < 4) continue
      const code = rec.slice(0, 2)
      if (code[0] === 'R' || code[0] === 'C') i++
      if (!code.includes('D')) rels.push(rec.slice(3))
    }
    const committed = tryGit(top, ['log', `--since=${since}`, '--name-only', '--diff-filter=d', '--format=', 'HEAD']) ?? ''
    rels.push(...committed.split('\n').filter(Boolean))
    for (const rel of rels) {
      const path = join(top, rel)
      if (files.has(path)) continue
      try {
        const st = statSync(path)
        if (st.isFile() && st.mtimeMs >= turnStartTime) files.set(path, { path, time: st.mtimeMs })
      } catch {}
      if (files.size >= 200) return [...files.values()]
    }
  }
  return [...files.values()]
}

export function check(raw, { lines = addedLines, ignore = () => false, scanBash = bashTouchedFiles } = {}) {
  const { events, turnStart, turnStartTime } = parseTranscript(raw)
  const turnEvents = events.slice(turnStart)
  const editPaths = new Set(turnEvents.filter((e) => e.kind === 'edit').map((e) => e.path))
  const extra = scanBash(events, turnStart, turnStartTime).filter((f) => !editPaths.has(f.path))
  const touched = new Set([...editPaths, ...extra.map((f) => f.path)].filter((p) => !ignore(p)))
  const issues = []
  for (const path of touched) {
    let added
    try {
      added = lines(path, turnStartTime)
    } catch (e) {
      if (isTimeout(e)) throw e
      continue
    }
    if (added?.length) issues.push(...analyzeAddedLines(path, added))
  }
  const merged = [...turnEvents, ...extra.map((f) => ({ kind: 'edit', path: f.path, time: f.time }))]
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e.time && b.e.time ? a.e.time - b.e.time : 0) || a.i - b.i)
    .map(({ e }) => e)
  const migrations = pendingMigrations(merged, 0).filter((p) => !ignore(p))
  return formatReport(issues, migrations)
}

export function decideStop(raw, deps = {}) {
  let input
  try {
    input = JSON.parse(raw)
  } catch {
    return null
  }
  const transcript = input.agent_transcript_path ?? input.transcript_path
  if (input.stop_hook_active || !transcript) return null
  try {
    const text = (deps.read ?? ((p) => readTail(p, TRANSCRIPT_TAIL_BYTES)))(transcript)
    const scratch = /\/(?:private\/)?tmp\//
    const reason = (deps.check ?? check)(text, { ignore: (p) => scratch.test(p) || p.includes('/.claude/') })
    return reason ? JSON.stringify({ decision: 'block', reason }) : null
  } catch (e) {
    if (e?.code === 'ENOENT') return null
    const reason = `[stop-check] Проверка диффа не выполнилась (${String(e?.message ?? e).slice(0, 200)}). Сам проверь изменённые файлы на комментарии, длинные тире и секреты, а новые миграции накати.`
    return JSON.stringify({ decision: 'block', reason })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startBudget(BUDGET_MS)
  const out = decideStop(readStdinSync())
  if (out) process.stdout.write(out)
}
