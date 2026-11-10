#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { readStdinSync } from './utils.mjs'
import { evaluate } from './guard-rules.mjs'
import { budget, isTimeout, readTail, startBudget } from './deadline.mjs'

const BUDGET_MS = 8000
const TRANSCRIPT_TAIL_BYTES = 16_000_000

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  if (content.some((b) => b?.type === 'tool_result')) return ''
  return content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
}

export function readMessageFile(path) {
  try {
    if (statSync(path).size > 1_000_000) return null
    return readFileSync(path, 'utf-8')
  } catch {
    return null
  }
}

function revExists(dir, rev) {
  try {
    execFileSync('git', ['-C', dir, 'rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { stdio: 'ignore', timeout: budget(2000) })
    return true
  } catch (e) {
    if (isTimeout(e)) throw e
    return false
  }
}

export function unpushedMessages(dir, sources) {
  if (!existsSync(dir)) return []
  const revs = sources.filter((s) => s.startsWith('-') || revExists(dir, s))
  if (!revs.some((s) => !s.startsWith('-') || s === '--branches')) return []
  const out = execFileSync('git', ['-C', dir, 'log', ...revs, '--not', '--remotes', '--format=%H%x00%B%x1e'], {
    encoding: 'utf-8',
    timeout: budget(3000),
    maxBuffer: 20_000_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return out.split('\x1e').map((r) => r.trim()).filter(Boolean).map((r) => {
    const [sha, message = ''] = r.split('\x00')
    return { sha, message }
  })
}

const BUILTIN_GIT = new Set(['add', 'am', 'apply', 'bisect', 'blame', 'branch', 'cat-file', 'checkout', 'cherry-pick', 'clean', 'clone', 'commit', 'config', 'describe', 'diff', 'fetch', 'grep', 'init', 'log', 'ls-files', 'merge', 'merge-base', 'mv', 'notes', 'pull', 'push', 'rebase', 'reflog', 'remote', 'reset', 'restore', 'rev-list', 'rev-parse', 'revert', 'rm', 'shortlog', 'show', 'stash', 'status', 'switch', 'tag', 'worktree'])
const aliasCache = new Map()

export function gitAlias(dir, sub) {
  if (!sub || BUILTIN_GIT.has(sub) || !/^[\w.-]+$/.test(sub)) return null
  const key = `${dir}\0${sub}`
  if (aliasCache.has(key)) return aliasCache.get(key)
  let value = null
  try {
    value = execFileSync('git', ['-C', existsSync(dir) ? dir : '/', 'config', '--get', `alias.${sub}`], { encoding: 'utf-8', timeout: budget(2000), stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
  } catch (e) {
    if (isTimeout(e)) throw e
    value = null
  }
  aliasCache.set(key, value)
  return value
}

export function remoteUrl(dir, name) {
  try {
    return execFileSync('git', ['-C', dir, 'remote', 'get-url', name], { encoding: 'utf-8', timeout: budget(2000), stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

export function lastUserMessage(transcriptPath) {
  if (!transcriptPath) return ''
  let raw
  try {
    raw = readTail(transcriptPath, TRANSCRIPT_TAIL_BYTES)
  } catch {
    return ''
  }
  const lines = raw.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line.includes('"type":"user"')) continue
    try {
      const entry = JSON.parse(line)
      if (entry.type !== 'user' || entry.isMeta) continue
      const text = textOf(entry.message?.content)
      if (text.trim() && !text.startsWith('<command-') && !text.startsWith('<local-command')) return text
    } catch {
      continue
    }
  }
  return ''
}

function denyOutput(reason) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `[guard] ${reason}`,
    },
  })
}

export function decide(raw, deps = {}) {
  try {
    const input = JSON.parse(raw)
    if (input.tool_name !== 'Bash') return null
    const verdict = (deps.evaluate ?? evaluate)({
      command: input.tool_input?.command ?? '',
      lastUserMessage: lastUserMessage(input.transcript_path),
      cwd: input.cwd ?? process.cwd(),
      readFile: readMessageFile,
      unpushedMessages,
      remoteUrl,
      gitAlias,
      isSubagent: Boolean(input.agent_id),
    })
    if (!verdict) return null
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: verdict.decision,
        permissionDecisionReason: `[guard] ${verdict.reason}`,
      },
    })
  } catch (e) {
    return denyOutput(`Guard упал и не смог проверить команду (${String(e?.message ?? e).slice(0, 200)}). Команда заблокирована, упрости её или почини guard.`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startBudget(BUDGET_MS)
  let raw = ''
  try {
    raw = readStdinSync()
  } catch {}
  const out = decide(raw)
  if (out) process.stdout.write(out)
}
