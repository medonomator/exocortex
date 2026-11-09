#!/usr/bin/env tsx
/**
 * Replay consensus from a saved result JSON — $0 cost.
 * Re-runs the consensus strategy on saved votingRecord
 * to test strategy changes without calling LLMs.
 *
 * Usage: npx tsx runner/src/replay-consensus.ts [result-file.json]
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// Import consensus engine directly from source
import { ConsensusEngine } from '@cognitive-swarm/consensus'
import type { Proposal, VoteRecord } from '@cognitive-swarm/core'

const RESULTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'results')

function main() {
  const file = process.argv[2]
  if (!file) {
    console.log('Usage: npx tsx runner/src/replay-consensus.ts <result-file.json>')
    console.log('   or: npx tsx runner/src/replay-consensus.ts latest')
    process.exit(1)
  }

  const filePath = file === 'latest'
    ? findLatest()
    : file.startsWith('/') ? file : join(RESULTS_DIR, file)

  console.log(`📂 Loading: ${filePath}`)
  const data = JSON.parse(readFileSync(filePath, 'utf-8'))

  if (!data.consensus?.votingRecord) {
    console.error('No votingRecord found in result file')
    process.exit(1)
  }

  const votes: VoteRecord[] = data.consensus.votingRecord
  console.log(`   Votes: ${votes.length}`)

  // Extract unique proposal IDs from votes
  const proposalIds = [...new Set(votes.map(v => v.proposalId))]
  const proposals: Proposal[] = proposalIds.map(id => ({
    id,
    content: `Proposal ${id}`,
    reasoning: 'replayed',
    sourceAgentId: 'replay',
    sourceSignalId: id,
    confidence: 0.5,
    timestamp: Date.now(),
  }))
  console.log(`   Proposals: ${proposals.length}`)

  // Summarize votes
  const stanceCounts: Record<string, number> = {}
  const weightsByStance: Record<string, number[]> = {}
  for (const v of votes) {
    const stance = v.vote.stance
    stanceCounts[stance] = (stanceCounts[stance] ?? 0) + 1
    if (!weightsByStance[stance]) weightsByStance[stance] = []
    weightsByStance[stance]!.push(v.vote.weight)
  }

  console.log('\n── Vote Summary ──')
  for (const [stance, count] of Object.entries(stanceCounts)) {
    const weights = weightsByStance[stance]!
    const avg = weights.reduce((a, b) => a + b, 0) / weights.length
    const max = Math.max(...weights)
    const min = Math.min(...weights)
    console.log(`   ${stance}: ${count} votes (weight avg=${avg.toFixed(3)}, min=${min.toFixed(3)}, max=${max.toFixed(3)})`)
  }

  // Run consensus with current strategy
  const engine = new ConsensusEngine({
    strategy: 'confidence-weighted',
    threshold: 0.5,
    minVoters: 2,
  })

  const result = engine.evaluate(proposals, votes)

  console.log('\n── Consensus Result ──')
  console.log(`   Decided: ${result.decided}`)
  console.log(`   Confidence: ${(result.confidence * 100).toFixed(1)}%`)
  console.log(`   Reasoning: ${result.reasoning}`)
  if (result.proposalId) {
    console.log(`   Winning proposal: ${result.proposalId}`)
  }

  // Compare with original
  console.log('\n── Original Result ──')
  console.log(`   Decided: ${data.consensus.decided}`)
  console.log(`   Confidence: ${(data.consensus.confidence * 100).toFixed(1)}%`)
  console.log(`   Reasoning: ${data.consensus.reasoning}`)

  console.log('\n── Comparison ──')
  if (result.decided !== data.consensus.decided) {
    console.log(`   ⚡ CHANGED: decided ${data.consensus.decided} → ${result.decided}`)
  }
  if (Math.abs(result.confidence - data.consensus.confidence) > 0.001) {
    console.log(`   ⚡ CHANGED: confidence ${(data.consensus.confidence * 100).toFixed(1)}% → ${(result.confidence * 100).toFixed(1)}%`)
  }
  if (result.decided === data.consensus.decided && Math.abs(result.confidence - data.consensus.confidence) < 0.001) {
    console.log(`   No change — same result`)
  }
}

function findLatest(): string {
  const files: string[] = (readdirSync(RESULTS_DIR) as string[])
    .filter((f: string) => f.startsWith('analytics-') && f.endsWith('.json') && !f.includes('-agents'))
    .sort()
  if (files.length === 0) throw new Error('No result files found')
  return join(RESULTS_DIR, files[files.length - 1]!)
}

main()
