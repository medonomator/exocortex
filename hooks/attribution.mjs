const PATTERNS = [
  /co-?authored-?by\s*[:=]/i,
  /generated\s+(?:with|by|using)\s+\[?\s*claude/i,
  /noreply@anthropic\.com/i,
  /claude\.(?:ai|com)\/(?:code|chat|share|artifact)/i,
  /^\s*claude-[\w-]+\s*[:=]/im,
  /--trailer[\s=]+['"]?\s*claude/i,
  /\u{1F916}/u,
]

export function normalize(text) {
  return text
    .normalize('NFKC')
    .replace(/[​-‍⁠﻿­]/g, '')
    .replace(/[‐-―−﹘﹣－]/g, '-')
    .replace(/[：︓﹕]/g, ':')
}

export function findAttribution(text) {
  if (!text) return null
  const clean = normalize(text)
  for (const p of PATTERNS) {
    const m = clean.match(p)
    if (m) return m[0].trim()
  }
  return null
}
