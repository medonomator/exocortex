import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function loadEnv() {
  try {
    const path = join(dirname(fileURLToPath(import.meta.url)), '..', '.env')
    const lines = readFileSync(path, 'utf-8').split('\n')
    for (const line of lines) {
      const match = line.match(/^([^#=]+)=(.*)$/)
      if (match) {
        const key = match[1].trim()
        const val = match[2].trim().replace(/^["']|["']$/g, '')
        if (!process.env[key]) process.env[key] = val
      }
    }
  } catch {
    // .env not found — rely on environment variables
  }
}
