import { closeSync, fstatSync, openSync, readSync } from 'node:fs'

export class BudgetExceeded extends Error {}

let deadline = Infinity

export function startBudget(ms) {
  deadline = Date.now() + ms
}

export function budget(ms) {
  const left = deadline - Date.now()
  if (left <= 0) throw new BudgetExceeded('hook time budget exceeded')
  return Math.min(ms, left)
}

export function isTimeout(e) {
  return e instanceof BudgetExceeded || e?.code === 'ETIMEDOUT'
}

export function readTail(path, maxBytes) {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const start = Math.max(0, size - maxBytes)
    const buf = Buffer.alloc(size - start)
    readSync(fd, buf, 0, buf.length, start)
    const text = buf.toString('utf-8')
    if (start === 0) return text
    const nl = text.indexOf('\n')
    return nl < 0 ? '' : text.slice(nl + 1)
  } finally {
    closeSync(fd)
  }
}
