import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Project name canonicalization shared by SessionStart briefing and
 * UserPromptSubmit recall.
 *
 * Runner/observer has historically stored project names inconsistently:
 *   - cwd basename "mind-forge-backend" vs observer recording "mind-forge"
 *   - mixed case "exocortex" and "Exocortex" in kg_entities
 *
 * Aliases live in project-aliases.json at the repo root (or the file named by
 * EXOCORTEX_PROJECT_ALIASES), so both hooks scope the same way. See
 * project-aliases.example.json for the format.
 */

const ALIASES_PATH = process.env.EXOCORTEX_PROJECT_ALIASES
  ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'project-aliases.json')

function loadAliases() {
  if (!existsSync(ALIASES_PATH)) return {}
  try {
    const parsed = JSON.parse(readFileSync(ALIASES_PATH, 'utf-8'))
    const result = {}
    for (const [key, names] of Object.entries(parsed)) {
      if (Array.isArray(names)) result[key.toLowerCase()] = names.filter((n) => typeof n === 'string')
    }
    return result
  } catch {
    return {}
  }
}

const PROJECT_ALIASES = loadAliases()

/**
 * cwd basename → list of project names actually recorded in the DB.
 * Always lowercase. Returns [] for empty input.
 */
export function resolveProjectNames(project) {
  if (!project) return []
  const key = project.toLowerCase()
  return PROJECT_ALIASES[key] ?? [key]
}

/**
 * Pick a single canonical project name for recall filtering (RecallService
 * only supports a single project filter, not an array). We use the FIRST
 * alias which is the canonical stored name. If unknown, lowercase cwd basename.
 */
export function canonicalProject(project) {
  const names = resolveProjectNames(project)
  return names[0] ?? null
}

/**
 * Extract project name from cwd path string. Strips trailing slash and
 * returns lowercased basename, or null if cwd is empty.
 */
export function projectFromCwd(cwd) {
  if (!cwd || typeof cwd !== 'string') return null
  const clean = cwd.replace(/\/+$/, '')
  const base = clean.split('/').pop()
  return base ? base.toLowerCase() : null
}
