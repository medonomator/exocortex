/**
 * Episode: time-stamped event / observation.
 * Level 0 in the abstraction ladder.
 */

export interface EpisodePayload {
  /** What happened, in natural language. */
  summary: string;
  /** Actors involved. */
  actors?: string[];
  /** Free-form tags ('bug', 'decision', 'insight'). */
  tags?: string[];
  /** Project/repo context. */
  project?: string;
  /** Event outcome if any ('resolved', 'abandoned', 'in-progress'). */
  outcome?: string;
}
