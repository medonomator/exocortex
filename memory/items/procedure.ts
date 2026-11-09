/**
 * Procedure: "when X happens → do Y" pattern.
 * Procedural memory with success/failure tracking for calibration.
 */

export interface ProcedurePayload {
  /** Short pattern name. */
  pattern: string;
  /** Condition that triggers this procedure. */
  trigger: string;
  /** Action to take. */
  action: string;
  /** Context tags ('docker', 'deploy', 'typescript'). */
  tags?: string[];
  project?: string;
  /** Counters - used for calibration (actual success rate vs conf.mean). */
  successCount: number;
  failureCount: number;
  /** Last time this procedure was actually applied. */
  lastAppliedAt?: Date;
}
