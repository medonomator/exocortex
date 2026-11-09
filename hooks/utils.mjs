import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function readStdinSync() {
  try {
    return readFileSync('/dev/stdin', 'utf-8')
  } catch {
    return ''
  }
}

function proxyFor(url) {
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? ''
  if (!proxy) return ''
  if (url.startsWith('http://localhost') || url.startsWith('http://127.0.0.1')) return ''
  return proxy
}

export function curlJson(url, body, authHeader) {
  const tmpFile = join(tmpdir(), `exocortex-curl-${process.pid}.json`)
  try {
    writeFileSync(tmpFile, JSON.stringify(body))
    const auth = authHeader ? `-H "Authorization: Bearer ${authHeader}"` : ''
    const proxyUrl = proxyFor(url)
    const proxy = proxyUrl ? `--proxy ${proxyUrl}` : ''
    const cmd = `curl -s --max-time 6 ${proxy} -H "Content-Type: application/json" ${auth} -d @${tmpFile} "${url}"`
    const result = execSync(cmd, { encoding: 'utf-8', timeout: 8000 })
    return JSON.parse(result)
  } catch {
    return null
  } finally {
    try { unlinkSync(tmpFile) } catch { /* */ }
  }
}
