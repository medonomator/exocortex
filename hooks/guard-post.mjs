#!/usr/bin/env node

import { existsSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readStdinSync } from './utils.mjs'
import { walk } from './guard-rules.mjs'
import { findAttribution } from './attribution.mjs'
import { unpushedMessages } from './guard.mjs'
import { budget, isTimeout, startBudget } from './deadline.mjs'

const BUDGET_MS = 7000

const MAX_DIRS = 12

function isDir(p) {
  try {
    return existsSync(p) && statSync(p).isDirectory()
  } catch {
    return false
  }
}

export function gitToplevel(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf-8', timeout: budget(2000), stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
  } catch (e) {
    if (isTimeout(e)) throw e
    return null
  }
}

export function candidateDirs(command, cwd, dirExists = isDir) {
  const dirs = new Set([cwd])
  for (const step of walk(command, cwd)) {
    dirs.add(step.dir)
    if (step.git) dirs.add(step.git.dir)
    for (const tok of step.tokens.slice(1)) {
      if (tok.startsWith('-') || tok.includes('\n')) continue
      const p = tok.startsWith('~/') ? resolve(process.env.HOME ?? '', tok.slice(2)) : isAbsolute(tok) ? tok : resolve(step.dir, tok)
      if (dirExists(p)) dirs.add(p)
    }
  }
  return [...dirs].slice(0, MAX_DIRS)
}

function uncheckedReason(why) {
  return `[guard] Проверка атрибуции после команды не выполнилась: ${why}. Если команда создавала или правила коммит, проверь git log -1 --format=%B вручную.`
}

export function decidePost(raw, deps = {}) {
  try {
    const input = JSON.parse(raw)
    if (input.tool_name !== 'Bash') return null
    const reason = (deps.inspect ?? inspect)({
      command: input.tool_input?.command ?? '',
      cwd: input.cwd ?? process.cwd(),
      unpushed: unpushedMessages,
    })
    return reason ? output(reason) : null
  } catch (e) {
    return output(uncheckedReason(`хук упал (${String(e?.message ?? e).slice(0, 160)})`))
  }
}

function output(reason) {
  return JSON.stringify({
    decision: 'block',
    reason,
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: reason },
  })
}

export function inspect({ command, cwd, unpushed, toplevel = gitToplevel, dirExists = isDir }) {
  const repos = new Set(candidateDirs(command, cwd, dirExists).map(toplevel).filter(Boolean))
  for (const repo of repos) {
    let log
    try {
      log = unpushed(repo, ['HEAD', '--since=15.minutes.ago'])
    } catch (e) {
      return uncheckedReason(`не смог прочитать свежие коммиты в ${repo} (${String(e?.message ?? e).slice(0, 160)})`)
    }
    for (const entry of log) {
      const hit = findAttribution(entry.message)
      if (hit) {
        return `[guard] Коммит ${entry.sha.slice(0, 8)} в ${repo} содержит атрибуцию ("${hit}"). Сразу перепиши сообщение через git commit --amend и проверь git log -1 --format=%B. Никаких Co-Authored-By, Claude-трейлеров, "Generated with Claude Code", ссылок на claude.ai.`
      }
    }
  }
  return null
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startBudget(BUDGET_MS)
  const out = decidePost(readStdinSync())
  if (out) process.stdout.write(out)
}
