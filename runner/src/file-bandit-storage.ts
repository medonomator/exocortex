import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { BanditParams } from '@cognitive-engine/core'
import type { SwarmBanditStorage } from '@cognitive-swarm/core'

// ═══════════════════════════════════════════
// FileBanditStorage — Persistent bandit state
// ═══════════════════════════════════════════
// Stores Thompson Bandit params (mu, sigma per action)
// to a JSON file so agents retain learning across runs.
//
// Compatible with BanditStorage from @cognitive-engine/bandit
// and SwarmBanditStorage from @cognitive-swarm/core.

interface StoredState {
  version: 1
  updatedAt: string
  actions: Record<string, {
    actionId: string
    mu: number[]
    sigma: number[]
    updatedAt: string
  }>
}

export class FileBanditStorage implements SwarmBanditStorage {
  private state: StoredState
  private dirty = false

  constructor(private readonly filePath: string) {
    this.state = this.load()
  }

  async getParams(actionId: string): Promise<BanditParams | null> {
    const stored = this.state.actions[actionId]
    if (!stored) return null
    return {
      actionId: stored.actionId,
      mu: stored.mu,
      sigma: stored.sigma,
      updatedAt: new Date(stored.updatedAt),
    }
  }

  async saveParams(params: BanditParams): Promise<void> {
    this.state.actions[params.actionId] = {
      actionId: params.actionId,
      mu: [...params.mu],
      sigma: [...params.sigma],
      updatedAt: params.updatedAt.toISOString(),
    }
    this.dirty = true
  }

  async listActionIds(): Promise<string[]> {
    return Object.keys(this.state.actions)
  }

  /** Flush pending changes to disk. Call after solve() completes. */
  flush(): void {
    if (!this.dirty) return
    this.state.updatedAt = new Date().toISOString()
    const dir = dirname(this.filePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(this.filePath, JSON.stringify(this.state, null, 2))
    this.dirty = false
  }

  /** Get a summary of learned state for logging. */
  getSummary(): { actions: number; lastUpdated: string } {
    return {
      actions: Object.keys(this.state.actions).length,
      lastUpdated: this.state.updatedAt,
    }
  }

  private load(): StoredState {
    if (!existsSync(this.filePath)) {
      return { version: 1, updatedAt: new Date().toISOString(), actions: {} }
    }
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf-8')) as StoredState
      if (raw.version !== 1) {
        return { version: 1, updatedAt: new Date().toISOString(), actions: {} }
      }
      return raw
    } catch {
      return { version: 1, updatedAt: new Date().toISOString(), actions: {} }
    }
  }
}
