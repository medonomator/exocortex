import { basename, extname } from 'node:path'
import { tokenize, stripPrefix } from './guard-rules.mjs'

const SLASH = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts', '.go', '.swift', '.kt', '.kts', '.java', '.rs', '.c', '.h', '.cc', '.cpp', '.hpp', '.m', '.mm', '.dart', '.php', '.cs', '.scala', '.groovy', '.gradle', '.proto', '.vue', '.svelte', '.scss', '.less'])
const BLOCK_ONLY = new Set(['.css'])
const HASH = new Set(['.py', '.sh', '.bash', '.zsh', '.fish', '.rb', '.yml', '.yaml', '.toml', '.tf', '.r', '.pl', '.ex', '.exs', '.nix', '.mk', '.conf'])
const HASH_NAMES = new Set(['Dockerfile', 'Makefile', 'Gemfile', 'Rakefile', 'Procfile', '.gitignore', '.dockerignore'])
const SQL = new Set(['.sql'])
const PROSE = new Set(['.md', '.mdx', '.txt', '.rst'])

const DIRECTIVE = /^\s*(?:eslint|@ts-|prettier-ignore|biome-ignore|go:|nolint|noqa|type:\s*ignore|pragma|istanbul|c8\s|swiftlint|ktlint|sourceMappingURL|\+goose|\+migrate|\+build|#?region|#?endregion|jshint|global\s|@jsx|webpack[A-Z]|NOSONAR|nosec|pylint|mypy|ruff|fmt:|shellcheck|-\*-|vim:|syntax=|escape=|deno-|oxlint|stylelint|@vite-ignore|@license|@preserve)/i

const SECRET_PATTERNS = [
  ['ключ Anthropic', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['ключ OpenAI', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/],
  ['GitHub токен', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}/],
  ['GitLab токен', /\bglpat-[A-Za-z0-9_-]{20,}/],
  ['Slack токен', /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ['AWS ключ', /\bAKIA[0-9A-Z]{16}\b/],
  ['Telegram bot token', /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Sentry DSN', /https:\/\/[0-9a-f]{32}@[\w.-]*sentry\.io\//],
  ['приватный ключ', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
  ['пароль в connection string', /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?):\/\/[^:\s/@]+:(?!\$|\{|%7B|<|\*+@)[^@\s]+@/i],
]

export function commentStyle(path) {
  const name = basename(path)
  const ext = extname(path).toLowerCase()
  if (HASH_NAMES.has(name) || name.startsWith('Dockerfile') || name.startsWith('.env')) return 'hash'
  if (SLASH.has(ext)) return 'slash'
  if (BLOCK_ONLY.has(ext)) return 'block'
  if (HASH.has(ext)) return 'hash'
  if (SQL.has(ext)) return 'sql'
  return null
}

export function stripStrings(line) {
  return line
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
}

function commentBody(code, style) {
  const markers = {
    slash: /(?:^|[\s;,{}()[\]])(\/\/+|\/\*+)(.*)$|^\s*(\*+)(?:\s(.*)|\/?$)/,
    block: /(?:^|\s)(\/\*+)(.*)$|^\s*(\*+)(?:\s(.*)|\/?$)/,
    hash: /(?:^|\s)(#+)(?![!{[(])(.*)$/,
    sql: /(?:^|\s)(--)(.*)$|(?:^|\s)(\/\*)(.*)$/,
  }
  const m = code.match(markers[style])
  if (!m) return null
  return (m[2] ?? m[4] ?? '').trim()
}

export function findComment(path, line, lineNo) {
  const style = commentStyle(path)
  if (!style) return false
  if (lineNo === 1 && line.startsWith('#!')) return false
  const code = stripStrings(line)
  if (style === 'hash' && /\$#|\$\{#/.test(code)) return false
  const body = commentBody(code, style)
  if (body === null) return false
  if (DIRECTIVE.test(body)) return false
  return true
}

export function findSecret(line) {
  for (const [label, p] of SECRET_PATTERNS) {
    if (p.test(line)) return label
  }
  return null
}

export function analyzeAddedLines(path, added) {
  const issues = []
  const prose = PROSE.has(extname(path).toLowerCase())
  for (const { line, text } of added) {
    if (text.includes('\u2014')) issues.push({ path, line, kind: 'длинное тире', text })
    const secret = findSecret(text)
    if (secret) issues.push({ path, line, kind: secret, text: text.replace(/[A-Za-z0-9_-]{12,}/g, (s) => `${s.slice(0, 4)}…`) })
    if (!prose && findComment(path, text, line)) issues.push({ path, line, kind: 'комментарий в коде', text })
  }
  return issues
}

export const MIGRATION_FILE = /(?:^|\/)(?:migrations?|db\/migrate|alembic\/versions)\/[^/]+\.(?:sql|go|ts|js|mjs|py)$/
const MIGRATION_EXCLUDE = /(?:^|\/)(?:embed\.go|.*_test\.go)$/
const MIGRATE_STEP = /^(?:go\s+run\s+\S*cmd\/migrate\b|make\s+(?:\S+\s+)*\S*migrate\S*$|\S*\/?migrate(?:\s|$)|goose\b.*\bup|(?:npm|yarn|pnpm|bun)\s+(?:run\s+)?\S*migrat|(?:(?:npx|bunx)\s+)?(?:prisma\s+(?:migrate\s+(?:dev|deploy)|db\s+push)|drizzle-kit\s+(?:push|migrate)|knex\s+migrate:(?:latest|up)|typeorm\S*\s+migration:run|sequelize\S*\s+db:migrate)|alembic\s+upgrade|python\d?\s+manage\.py\s+migrate|(?:bundle\s+exec\s+)?(?:rails|rake)\s+db:migrate|psql\b.*(?:\s-f\s|<))/i

export function isMigrateCommand(command) {
  return tokenize(command).some((seg) => {
    const t = stripPrefix(seg)
    if (!t.length) return false
    return MIGRATE_STEP.test([t[0].split('/').pop(), ...t.slice(1)].join(' ')) || MIGRATE_STEP.test(t.join(' '))
  })
}

export function isMigrationFile(path) {
  return MIGRATION_FILE.test(path) && !MIGRATION_EXCLUDE.test(path)
}

export function pendingMigrations(events, turnStart) {
  let lastMigrationEdit = -1
  const files = new Set()
  events.forEach((e, i) => {
    if (e.kind === 'edit' && isMigrationFile(e.path)) {
      lastMigrationEdit = i
      if (i >= turnStart) files.add(e.path)
    }
  })
  if (!files.size) return []
  const applied = events.some((e, i) => i > lastMigrationEdit && e.kind === 'bash' && e.ok && isMigrateCommand(e.command))
  return applied ? [] : [...files]
}

export function formatReport(issues, migrations) {
  const lines = []
  for (const i of issues.slice(0, 20)) {
    lines.push(`${i.path}:${i.line} ${i.kind}: ${i.text.trim().slice(0, 140)}`)
  }
  if (issues.length > 20) lines.push(`и ещё ${issues.length - 20}`)
  for (const f of migrations) {
    lines.push(`${f} новая миграция не накатана на локальную БД (для Wisme: cd services/<service> && go run ./cmd/migrate -command=up)`)
  }
  if (!lines.length) return null
  return `[stop-check] Перед отчётом исправь:\n${lines.join('\n')}\nКомментарии удалить, длинные тире заменить перестройкой фразы, секреты вынести в env. Ложное срабатывание: скажи об этом в отчёте.`
}
