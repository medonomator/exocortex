import { isAbsolute, resolve } from 'node:path'
import { homedir } from 'node:os'
import { findAttribution } from './attribution.mjs'

const FORBIDDEN_GIT = new Set(['reset', 'checkout', 'restore', 'stash', 'worktree'])
const READ_ONLY_GIT = { stash: new Set(['list', 'show']), worktree: new Set(['list']) }
const GIT_OPTS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace'])
const WRAPPERS = new Set(['sudo', 'command', 'env', 'nohup', 'time', 'exec'])

const GIT_MESSAGE_WRITERS = new Set(['commit', 'tag', 'merge', 'notes', 'commit-tree', 'interpret-trailers', 'revert', 'cherry-pick', 'am', 'rebase', 'pull'])
const FORGE_CLIS = new Set(['gh', 'glab', 'hub'])
const MESSAGE_FILE_FLAGS = new Set(['-F', '--file', '--body-file', '--description-file', '-t', '--template', '--notes-file'])

const PAID_KEY_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{10,}/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/,
  /\bapi\.anthropic\.com\b/,
  /\bapi\.openai\.com\b/,
  /\$\{?(?:ANTHROPIC|OPENAI)_API_KEY\b/,
]

function isDeployStep(tokens) {
  const [head, a, b] = tokens
  const bin = head?.split('/').pop()
  if (['npm', 'yarn', 'pnpm', 'bun'].includes(bin)) return a === 'deploy' || (a === 'run' && b === 'deploy')
  if (bin === 'vercel') return tokens.includes('--prod')
  if (bin === 'gh') return a === 'workflow' && b === 'run'
  return false
}

const REMOTE_DEPLOY = /pm2\s+(?:restart|reload|start)|docker[\s-]compose\b[^\n]*?\bup\b|systemctl\s+(?:restart|reload|start)|deploy\.sh|git\s+pull/

const PUSH_APPROVAL = /депло|выкат|обнови\s+прод|запуш|(?<!\p{L})пуш(?:ь|и|ни|нуть|ните|ай|ить|им)?(?!\p{L})|(?<!\p{L})push(?!\p{L})|(?<!\p{L})deploy(?!\p{L})/giu
const PAID_APPROVAL = /(?:разреш|можно|дёргай|дергай|юзай|используй)[^.\n]{0,40}(?:api|апи|ключ|sk-)/i

const HEREDOC = /<<-?[ \t]*(['"]?)(\w+)\1([^\n]*)\n([\s\S]*?)\n[ \t]*\2(?=[\s)]|$)/g
const HEREDOC_MARK = /^\u0000H(\d+)\u0000$/
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])
const MAX_DEPTH = 4
const MAX_SCRIPT_BYTES = 200_000

function closingParen(src, start) {
  let depth = 1
  for (let k = start; k < src.length; k++) {
    const ch = src[k]
    if (ch === '\\') k++
    else if (ch === "'") {
      const q = src.indexOf("'", k + 1)
      if (q < 0) return -1
      k = q
    } else if (ch === '(') depth++
    else if (ch === ')' && --depth === 0) return k
  }
  return -1
}

export function tokenize(command) {
  const bodies = []
  const marks = []
  const src = command.replace(/\$\{IFS\}|\$IFS\b/g, ' ').replace(HEREDOC, (m, q, tag, rest, body) => {
    bodies.push(body)
    const ph = ` \u0000H${bodies.length - 1}\u0000 ${rest}`
    marks.push([ph, m])
    return ph
  })
  const restore = (text) => marks.reduce((acc, [ph, m]) => acc.split(ph).join(m), text)
  const segments = []
  let tokens = []
  let subs = []
  let cur = ''
  let has = false
  const endToken = () => {
    if (has) tokens.push(cur)
    cur = ''
    has = false
  }
  const endSegment = () => {
    endToken()
    if (tokens.length) {
      const heredocs = []
      const plain = []
      for (const t of tokens) {
        const m = t.match(HEREDOC_MARK)
        if (m) heredocs.push(bodies[Number(m[1])])
        else plain.push(t)
      }
      if (plain.length || heredocs.length || subs.length) segments.push(Object.assign(plain, { heredocs, subs }))
    } else if (subs.length) {
      segments.push(Object.assign([], { heredocs: [], subs }))
    }
    tokens = []
    subs = []
  }
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (c === "'") {
      const j = src.indexOf("'", i + 1)
      const end = j < 0 ? src.length : j
      cur += src.slice(i + 1, end)
      has = true
      i = end
    } else if (c === '"') {
      let j = i + 1
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          cur += src[j + 1]
          j += 2
        } else if (src[j] === '$' && src[j + 1] === '(' && closingParen(src, j + 2) > 0) {
          const end = closingParen(src, j + 2)
          const raw = src.slice(j, end + 1)
          subs.push({ command: restore(src.slice(j + 2, end)), raw })
          cur += raw
          j = end + 1
        } else if (src[j] === '`' && src.indexOf('`', j + 1) > 0) {
          const end = src.indexOf('`', j + 1)
          const raw = src.slice(j, end + 1)
          subs.push({ command: restore(src.slice(j + 1, end)), raw })
          cur += raw
          j = end + 1
        } else {
          cur += src[j++]
        }
      }
      has = true
      i = j
    } else if (c === '\\' && i + 1 < src.length) {
      if (src[i + 1] !== '\n') {
        cur += src[i + 1]
        has = true
      }
      i++
    } else if (c === '$' && src[i + 1] === '(') {
      endSegment()
      i++
    } else if ('\n;|&()`{}'.includes(c) && !has) {
      endSegment()
    } else if ('\n;|&()`'.includes(c)) {
      endSegment()
    } else if (c === ' ' || c === '\t') {
      endToken()
    } else {
      cur += c
      has = true
    }
  }
  endSegment()
  return segments
}

function expandPath(base, p) {
  if (!p || p === '~') return homedir()
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2))
  return isAbsolute(p) ? p : resolve(base, p)
}

const base = (t) => t?.split('/').pop()

const SHELL_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}'])
const LIST_HEADERS = new Set(['for', 'select', 'case'])

export function stripPrefix(tokens) {
  let i = 0
  while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]) || WRAPPERS.has(tokens[i]) || SHELL_KEYWORDS.has(tokens[i]))) i++
  return tokens.slice(i)
}

export function parseGit(tokens, cwd = process.cwd()) {
  const t = stripPrefix(tokens)
  if (base(t[0]) !== 'git') return null
  let dir = cwd
  let i = 1
  const configs = []
  while (i < t.length && t[i].startsWith('-')) {
    if (t[i] === '-C') dir = expandPath(dir, t[i + 1])
    if (t[i] === '-c' && t[i + 1]) configs.push(t[i + 1])
    if (t[i].startsWith('-c') && t[i].length > 2) configs.push(t[i].slice(2))
    if (t[i].startsWith('--config-env=')) configs.push(t[i].slice(13))
    i += GIT_OPTS_WITH_VALUE.has(t[i]) || t[i] === '--config-env' ? 2 : 1
  }
  return { sub: t[i] ?? '', args: t.slice(i + 1), dir, configs }
}

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s

function expandVars(token, vars) {
  return token.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, a, b) => {
    const name = a ?? b
    return vars[name] ?? process.env[name] ?? m
  })
}

function shellScriptArg(t) {
  for (let i = 1; i < t.length; i++) {
    const a = t[i]
    if (/^-[a-z]*c[a-z]*$/i.test(a)) return { inline: t[i + 1] ?? '' }
    if (a === '-s' || a === '--') continue
    if (a.startsWith('-')) continue
    return { file: a }
  }
  return {}
}

function packageScript(dir, name, readFile) {
  const raw = readFile(resolve(dir, 'package.json'))
  if (!raw) return null
  try {
    return JSON.parse(raw).scripts?.[name] ?? null
  } catch {
    return null
  }
}

const WORKSPACE_FLAGS = /^(?:-w|-ws|--workspaces?(?:=.*)?|--filter(?:=.*)?|-F|-r|--recursive|--prefix(?:=.*)?|-C|--cwd(?:=.*)?|--dir(?:=.*)?)$/

function nestedCommands(t, dir, heredocs, ctx) {
  const head = base(t[0])
  const out = []
  if (SHELLS.has(head)) {
    const { inline, file } = shellScriptArg(t)
    if (inline !== undefined) out.push({ command: inline, dir })
    else if (file) {
      const body = ctx.readFile(expandPath(dir, file))
      if (body && body.length <= MAX_SCRIPT_BYTES) out.push({ command: body, dir })
    } else {
      for (const h of heredocs) out.push({ command: h, dir })
    }
  } else if (head === 'eval') {
    out.push({ command: t.slice(1).join(' '), dir })
  } else if (head === 'source' || head === '.') {
    const body = t[1] && ctx.readFile(expandPath(dir, t[1]))
    if (body && body.length <= MAX_SCRIPT_BYTES) out.push({ command: body, dir })
  } else if (t[0] && (t[0].startsWith('./') || t[0].startsWith('/') || t[0].startsWith('~/')) && /\.(?:sh|bash|zsh)$|^[^.]+$/.test(base(t[0]))) {
    const body = ctx.readFile(expandPath(dir, t[0]))
    if (body && body.length <= MAX_SCRIPT_BYTES && /^#!.*\b(?:ba|z|da|k)?sh\b/.test(body)) out.push({ command: body, dir })
  } else if (['npm', 'pnpm', 'yarn', 'bun'].includes(head) && !t.some((a) => WORKSPACE_FLAGS.test(a)) && t[1] !== 'workspace' && t[1] !== 'workspaces') {
    const name = t[1] === 'run' || t[1] === 'run-script' ? t[2] : t[1]
    const script = name && packageScript(dir, name, ctx.readFile)
    if (script) {
      out.push({ command: script, dir })
      const pre = packageScript(dir, `pre${name}`, ctx.readFile)
      const post = packageScript(dir, `post${name}`, ctx.readFile)
      if (pre) out.push({ command: pre, dir })
      if (post) out.push({ command: post, dir })
    }
  }
  return out
}

const EXEC_WRAPPERS = new Set(['xargs', 'find', 'fd', 'timeout', 'gtimeout', 'nice', 'ionice', 'watch', 'parallel', 'flock', 'caffeinate', 'stdbuf', 'chronic', 'entr', 'script', 'unbuffer', 'doas', 'su', 'runuser', 'arch', 'rtk'])

function embeddedGit(t, dir) {
  if (!EXEC_WRAPPERS.has(base(t[0])) && !WRAPPERS.has(base(t[0]))) return null
  const i = t.findIndex((tok, idx) => idx > 0 && base(tok) === 'git')
  return i > 0 ? parseGit(t.slice(i), dir) : null
}

function resolveAlias(git, ctx, depth) {
  if (!git || depth > MAX_DEPTH) return { git }
  const inline = git.configs?.map((c) => c.match(/^alias\.([^=]+)=(.*)$/s)).find((m) => m && m[1].toLowerCase() === git.sub.toLowerCase())
  const alias = inline ? inline[2] : ctx.gitAlias?.(git.dir, git.sub)
  if (!alias) return { git }
  const rest = git.args.join(' ')
  if (alias.startsWith('!')) return { git: null, nested: `${alias.slice(1)} ${rest}` }
  const parsed = parseGit(['git', ...alias.split(/\s+/).filter(Boolean), ...git.args], git.dir)
  if (parsed) parsed.configs = [...git.configs, ...parsed.configs]
  return resolveAlias(parsed, ctx, depth + 1)
}

const HOOK_SKIP_ENV = /^(?:HUSKY|HUSKY_SKIP_HOOKS|SKIP_HOOKS|PRE_COMMIT_ALLOW_NO_CONFIG|SKIP|LEFTHOOK|GIT_CONFIG_PARAMETERS|GIT_CONFIG_COUNT)$/
const VALUE_FLAGS = new Set(['m', 'F', 'c', 'C', 't', 'S', 'u'])

function skipsHooks(step) {
  const { git, env } = step
  if (git) {
    if (git.configs.some((c) => /^core\.hookspath\b/i.test(c))) return true
    if (git.sub === 'config') {
      const i = git.args.findIndex((a) => /^core\.hookspath$/i.test(a))
      const reads = git.args.some((a) => /^--(?:get|get-all|get-regexp|list|unset|unset-all|show-origin)$|^-l$/.test(a))
      if (i >= 0 && !reads && git.args[i + 1] !== undefined) return true
    }
    if (git.args.includes('--no-verify')) return true
    if (git.sub === 'commit') {
      let takesValue = false
      for (const a of git.args) {
        if (takesValue) {
          takesValue = false
          continue
        }
        if (a === '--') break
        if (/^--(?:message|file|reuse-message|reedit-message|template|author|date|cleanup|fixup|squash|trailer|pathspec-from-file)$/.test(a)) {
          takesValue = true
          continue
        }
        if (!/^-[A-Za-z]+$/.test(a)) continue
        const flags = a.slice(1)
        for (let k = 0; k < flags.length; k++) {
          if (flags[k] === 'n') return true
          if (VALUE_FLAGS.has(flags[k])) {
            takesValue = k === flags.length - 1
            break
          }
        }
      }
    }
  }
  if (git && Object.entries(env ?? {}).some(([k, v]) => HOOK_SKIP_ENV.test(k) && (k !== 'HUSKY' || v === '0') && (k !== 'LEFTHOOK' || v === '0') && (k !== 'SKIP' || v !== ''))) return true
  return false
}

const RUNS_PROCESS = [
  [/^python[\d.]*$/, /\bsubprocess\b|\bos\.(?:system|exec\w*|popen|spawn\w*)\b|\bpty\.spawn\b|\bsh\.git\b|\bplumbum\b/],
  [/^perl$/, /\bsystem\s*[(\s]|\bexec\s*[(\s]|\bqx\s*[({/|]|`/],
  [/^ruby$/, /\bsystem\s*[(\s]|\bexec\s*[(\s]|%x[({[]|`|\bOpen3\b|\bspawn\s*\(/],
  [/^(?:node|bun|deno)$/, /child_process|\bexec(?:Sync|FileSync|File)?\s*\(|\bspawn(?:Sync)?\s*\(|Deno\.Command|Bun\.spawn|\$`/],
  [/^php$/, /\b(?:shell_exec|system|exec|passthru|proc_open|popen)\s*\(|`/],
  [/^osascript$/, /do shell script/],
]
const CODE_FLAGS = new Set(['-c', '-e', '-E', '--eval', '-p', '--print', '-r'])
const FORBIDDEN_IN_CODE = /\bgit['"]?\s*[,\s]\s*(?:['"]?-\S+['"]?\s*,?\s*)*['"]?(reset|checkout|restore|stash|worktree)\b(?!['"]?\s*,?\s*['"]?(?:list|show)\b)|--no-verify|core\.hooksPath/

export function interpreterCode(step) {
  const runs = RUNS_PROCESS.find(([bin]) => bin.test(base(step.tokens[0]) ?? ''))?.[1]
  if (!runs) return []
  const code = []
  const t = step.tokens
  for (let i = 1; i < t.length; i++) if (CODE_FLAGS.has(t[i]) && t[i + 1]) code.push(t[i + 1])
  code.push(...(step.heredocs ?? []))
  return code.filter((c) => runs.test(c))
}

function writtenFile(t, dir) {
  const bin = base(t[0])
  if (bin === 'cat') {
    const i = t.findIndex((tok) => tok === '>' || tok === '>>')
    if (i > 0 && t[i + 1]) return expandPath(dir, t[i + 1])
    const glued = t.find((tok) => /^>>?[^>]/.test(tok))
    return glued ? expandPath(dir, glued.replace(/^>>?/, '')) : null
  }
  if (bin === 'tee') {
    const target = t.slice(1).find((tok) => !tok.startsWith('-'))
    return target ? expandPath(dir, target) : null
  }
  return null
}

export function walk(command, cwd, ctx = {}, depth = 0) {
  const c = { readFile: () => null, gitAlias: null, ...ctx }
  if (!c.written) {
    const written = new Map()
    const read = c.readFile
    c.written = written
    c.readFile = (p) => written.get(p) ?? read(p)
  }
  const out = []
  if (!command) return out
  if (depth > MAX_DEPTH) return [{ tokens: [], dir: cwd, git: null, depth, tooDeep: true }]
  const vars = {}
  let dir = cwd
  for (const raw of tokenize(command)) {
    for (const sub of raw.subs ?? []) out.push(...walk(sub.command, dir, c, depth + 1))
    const tokens = raw.map((tok) => expandVars(tok, vars))
    if (!tokens.length && !raw.heredocs.length) continue
    if (LIST_HEADERS.has(tokens[0]) && !raw.heredocs.length) continue
    const assigns = tokens[0] === 'export' || tokens[0] === 'local' ? tokens.slice(1) : tokens
    if (assigns.length && assigns.every((tok) => ASSIGNMENT.test(tok)) && !raw.heredocs.length) {
      for (const tok of assigns) {
        const [, k, v] = tok.match(ASSIGNMENT)
        vars[k] = v
      }
      continue
    }
    const t = stripPrefix(tokens)
    const env = { ...vars }
    for (const tok of tokens.slice(0, tokens.length - t.length)) {
      const m = tok.match(ASSIGNMENT)
      if (m) env[m[1]] = m[2]
    }
    if (raw.heredocs.length) {
      const target = writtenFile(t, dir)
      if (target) c.written.set(target, raw.heredocs[0])
    }
    if (t[0] === 'cd' || t[0] === 'pushd') {
      dir = expandPath(dir, t[1])
      continue
    }
    const { git, nested: aliasCmd } = resolveAlias(parseGit(t, dir) ?? embeddedGit(t, dir) ?? embeddedGit(tokens.filter((tok, i) => i >= tokens.findIndex((x) => !ASSIGNMENT.test(x))), dir), c, 0)
    out.push({ tokens: t, dir, git, depth, env, heredocs: raw.heredocs, subs: raw.subs ?? [] })
    if (aliasCmd) out.push(...walk(aliasCmd, git?.dir ?? dir, c, depth + 1))
    if (base(t[0]) === 'ssh') continue
    for (const n of nestedCommands(t, dir, raw.heredocs, c)) out.push(...walk(n.command, n.dir, c, depth + 1))
  }
  return out
}

function messageFiles(args, dir) {
  const files = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const eq = a.indexOf('=')
    if (a.startsWith('--') && eq > 0 && MESSAGE_FILE_FLAGS.has(a.slice(0, eq))) {
      files.push(a.slice(eq + 1))
    } else if (MESSAGE_FILE_FLAGS.has(a)) {
      files.push(args[++i])
    }
  }
  return files.filter((f) => f && f !== '-' && f !== '/dev/stdin').map((f) => expandPath(dir, f))
}

function isMessageWriter(step) {
  if (step.git) return GIT_MESSAGE_WRITERS.has(step.git.sub)
  return FORGE_CLIS.has(step.tokens[0]?.split('/').pop())
}

function pushSources(args) {
  const flags = args.filter((a) => a.startsWith('-'))
  if (flags.some((f) => f === '--all' || f === '--mirror' || f === '--branches')) return ['--branches']
  const positional = args.filter((a) => !a.startsWith('-'))
  const refspecs = positional.slice(1)
  if (!refspecs.length) return ['HEAD']
  return refspecs
    .map((r) => r.replace(/^\+/, '').split(':')[0])
    .filter(Boolean)
}

const NEGATION = /(?:^|[^\p{L}'’])(?:не|нельзя|без|никаких|ничего|not|no|never|without|don['’]?t|doesn['’]?t|shouldn['’]?t|won['’]?t|mustn['’]?t|can['’]?t|cannot|avoid|stop)(?=[^\p{L}'’]|$)/iu

export function isApproved(message, pattern) {
  if (!message) return false
  for (const m of message.matchAll(pattern)) {
    const clause = message.slice(Math.max(0, m.index - 40), m.index).split(/[.,;:!?\n()]/).pop()
    if (!NEGATION.test(clause)) return true
  }
  return false
}

function deny(reason) {
  return { decision: 'deny', reason }
}

const ATTRIBUTION_HINT = 'Коммиты и PR только про суть изменения, без Co-Authored-By, Claude-трейлеров, "Generated with Claude Code", ссылок на claude.ai и эмодзи-роботов.'

const SEARCH_BINS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'find', 'fd', 'ls', 'cat', 'bat', 'less', 'head', 'tail', 'wc', 'sort', 'uniq', 'cut', 'tr', 'diff', 'jq'])
const GIT_READ = new Set(['grep', 'log', 'show', 'diff', 'blame', 'status'])
const SED_DELETE = /^\/.+\/I?d$/

function isSearchStep(step) {
  if (step.git) return GIT_READ.has(step.git.sub)
  return SEARCH_BINS.has(base(step.tokens[0]))
}

function isFilterStep(step) {
  const bin = base(step.tokens[0])
  if (['grep', 'egrep', 'fgrep', 'rg'].includes(bin)) return step.tokens.some((t) => t === '--invert-match' || /^-[A-Za-z]*v[A-Za-z]*$/.test(t))
  if (bin === 'sed') return step.tokens.slice(1).some((t) => SED_DELETE.test(t))
  return false
}

function withoutSubs(step) {
  return step.tokens.map((t) => (step.subs ?? []).reduce((acc, s) => acc.split(s.raw).join(' '), t))
}

function scanText(step) {
  if (!isFilterStep(step)) return [withoutSubs(step).join(' '), ...(step.heredocs ?? [])].join('\n')
  const bin = base(step.tokens[0])
  const kept = bin === 'sed' ? step.tokens.filter((t) => !SED_DELETE.test(t)) : [step.tokens[0]]
  return [kept.join(' '), ...(step.heredocs ?? [])].join('\n')
}

export function checkAttribution({ command, cwd, readFile, unpushedMessages, gitAlias = null }) {
  const steps = walk(command, cwd, { readFile, gitAlias })

  const writers = steps.filter(isMessageWriter)
  if (writers.length) {
    const filtered = steps.some(isFilterStep)
    const texts = filtered ? [...steps.map(scanText), ...[...command.matchAll(HEREDOC)].map((m) => m[4])] : [command]
    for (const w of writers) {
      const args = w.git ? w.git.args : w.tokens.slice(1)
      for (const f of messageFiles(args, w.git?.dir ?? w.dir)) {
        const content = readFile(f)
        if (content) texts.push(content)
      }
    }
    const hit = findAttribution(texts.join('\n'))
    if (hit) return deny(`В сообщении коммита или PR атрибуция ("${hit}"). ${ATTRIBUTION_HINT}`)
  }

  for (const s of steps) {
    if (s.git?.sub !== 'push') continue
    let log
    try {
      log = unpushedMessages(s.git.dir, pushSources(s.git.args))
    } catch (e) {
      return deny(`Не смог проверить коммиты перед push на атрибуцию (${String(e.message ?? e).slice(0, 200)}). Проверь вручную через git log.`)
    }
    for (const entry of log) {
      const hit = findAttribution(entry.message)
      if (hit) return deny(`Коммит ${entry.sha.slice(0, 8)} содержит атрибуцию ("${hit}"). Перепиши сообщение через git commit --amend до push. ${ATTRIBUTION_HINT}`)
    }
  }

  return null
}

function isLocalUrl(url) {
  if (!url) return false
  if (url.startsWith('file://')) return true
  if (/^[\w.-]+@[\w.-]+:/.test(url) || /^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return false
  return url.startsWith('/') || url.startsWith('.') || url.startsWith('~')
}

function isLocalRemote(push, steps, remoteUrl) {
  const positional = push.git.args.filter((a) => !a.startsWith('-'))
  const remote = positional[0] ?? 'origin'
  if (isLocalUrl(remote)) return true
  const added = steps.find((s) => s.git?.sub === 'remote' && s.git.args[0] === 'add' && s.git.args[1] === remote)
  if (added) return isLocalUrl(added.git.args[2])
  return isLocalUrl(remoteUrl(push.git.dir, remote))
}

export function evaluate({ command, lastUserMessage = '', cwd = process.cwd(), readFile = () => null, unpushedMessages = () => [], remoteUrl = () => null, gitAlias = null, isSubagent = false }) {
  if (!command) return null
  const ctx = { readFile, gitAlias }
  const steps = walk(command, cwd, ctx)
  const approval = isSubagent ? '' : lastUserMessage

  if (steps.some((s) => s.tooDeep)) {
    return deny('Слишком глубокая вложенность команд (bash -c, eval, скрипты). Не могу проверить, запусти проще.')
  }

  for (const step of steps) {
    for (const code of interpreterCode(step)) {
      const m = code.match(FORBIDDEN_IN_CODE)
      if (m) return deny(`Скрипт вызывает запрещённое ("${m[0].slice(0, 60)}"). Откат через git и обход хуков запрещены и из кода.`)
    }
    const { git } = step
    if (git) {
      const readOnly = READ_ONLY_GIT[git.sub]?.has(git.args[0])
      if (FORBIDDEN_GIT.has(git.sub) && !readOnly) {
        return deny(`git ${git.sub} запрещён правилами. Сломал, значит чини поверх через Edit, без отката.`)
      }
    }
    if (skipsHooks(step)) {
      return deny('Обход git-хуков запрещён (--no-verify, commit -n, core.hooksPath, HUSKY=0). Хук упал, значит чини причину.')
    }
  }

  const attribution = checkAttribution({ command, cwd, readFile, unpushedMessages, gitAlias })
  if (attribution) return attribution

  const subagentNote = isSubagent ? ' Субагент не может получить разрешение, это делает только основной агент.' : ''
  const pushes = steps.filter((s) => s.git?.sub === 'push')
  const needsApproval = pushes.some((p) => !isLocalRemote(p, steps, remoteUrl))
  if (needsApproval && !isApproved(approval, PUSH_APPROVAL)) {
    return deny(`git push без явной просьбы в последнем сообщении user. Push в main означает автодеплой. Спроси user.${subagentNote}`)
  }

  const sshSteps = steps.filter((s) => base(s.tokens[0]) === 'ssh')
  const isRemoteDeploy = sshSteps.length > 0 && (REMOTE_DEPLOY.test(command) || sshSteps.some((s) => REMOTE_DEPLOY.test(s.tokens.join(' '))))
  const isLocalDeploy = steps.some((s) => isDeployStep(s.tokens))
  if ((isRemoteDeploy || isLocalDeploy) && !isApproved(approval, PUSH_APPROVAL)) {
    return deny(`Похоже на деплой, а в последнем сообщении user нет просьбы задеплоить. Спроси user.${subagentNote}`)
  }

  const paidText = steps.filter((s) => !isSearchStep(s)).map((s) => [...Object.entries(s.env ?? {}).map(([k, v]) => `${k}=${v}`), withoutSubs(s).join(' '), ...(s.heredocs ?? [])].join('\n')).join('\n')
  if (PAID_KEY_PATTERNS.some((p) => p.test(paidText)) && !PAID_APPROVAL.test(approval)) {
    return deny(`Вызов платного API без разрешения на эту задачу. Дай оценку в $ и спроси user.${subagentNote}`)
  }

  return null
}
