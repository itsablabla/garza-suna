/**
 * Stuck-session reaper.
 *
 * A real wedged OpenCode session emits zero observable activity — no token
 * chunks, no status transitions, no new messages — while staying in a
 * non-idle state. A healthy long-running agent emits signals constantly,
 * even during long tool calls.
 *
 * This primitive does NOT use wall-clock "has been busy for X seconds" as a
 * kill condition. That would abort autonomous agents doing legitimate
 * long-running work. Instead it tracks *observable activity* per session
 * and only flags sessions that have gone silent for `idleMs` AND are older
 * than `minAgeMs` AND are NOT marked `noReap`.
 *
 * Pure primitive: no timers, no I/O. Consumers call `observe()` with the
 * current `/session/status` snapshot each tick, then `findStuck()` returns
 * the ids to POST `/session/:id/abort` on. Clock is injected for tests.
 */

export interface ReaperOptions {
  /** ms of zero observable activity while non-idle before a session is flagged. Default 600_000 (10min). */
  idleMs: number
  /** min age in ms before a session can be flagged, protects warm-ups. Default 60_000. */
  minAgeMs: number
  now?: () => number
}

export interface SessionObservation {
  sessionId: string
  /** OpenCode session status type — anything other than 'idle' is "non-idle". */
  type: string
  /**
   * Any monotonic signal that changes when there is observable activity.
   * Options the caller can use (pick any that's cheap to compute):
   *   - session.message count
   *   - session.updatedAt epoch ms
   *   - hash of status + messageCount
   * When this value changes between ticks, the session is considered active.
   */
  activitySeq?: string | number
  /** Opt-out flag from session metadata — if true, never flagged. */
  noReap?: boolean
  /** Session creation time (unix ms) — protects warm-ups via minAgeMs. */
  createdAt?: number
}

export interface ReaperSessionState {
  sessionId: string
  lastType: string
  lastActivitySeq: string | number | undefined
  lastActivityAt: number
  firstSeenAt: number
  noReap: boolean
  createdAt: number | undefined
}

export interface ReaperSnapshot {
  trackedSessions: number
  stuckSessions: string[]
  lastScanAt: number | null
  options: { idleMs: number; minAgeMs: number }
}

export class StuckSessionReaper {
  private readonly idleMs: number
  private readonly minAgeMs: number
  private readonly now: () => number
  private readonly state = new Map<string, ReaperSessionState>()
  private lastScanAt: number | null = null
  private lastStuck: string[] = []

  constructor(opts: ReaperOptions) {
    if (opts.idleMs <= 0) throw new Error('idleMs must be > 0')
    if (opts.minAgeMs < 0) throw new Error('minAgeMs must be >= 0')
    this.idleMs = opts.idleMs
    this.minAgeMs = opts.minAgeMs
    this.now = opts.now ?? Date.now
  }

  observe(observations: SessionObservation[]): void {
    const now = this.now()
    const seenIds = new Set<string>()

    for (const obs of observations) {
      seenIds.add(obs.sessionId)
      const prev = this.state.get(obs.sessionId)

      if (!prev) {
        this.state.set(obs.sessionId, {
          sessionId: obs.sessionId,
          lastType: obs.type,
          lastActivitySeq: obs.activitySeq,
          lastActivityAt: now,
          firstSeenAt: now,
          noReap: Boolean(obs.noReap),
          createdAt: obs.createdAt,
        })
        continue
      }

      // Any observable change → bump activity timestamp.
      const typeChanged = prev.lastType !== obs.type
      const seqChanged = prev.lastActivitySeq !== obs.activitySeq

      if (typeChanged || seqChanged) {
        prev.lastActivityAt = now
      }
      prev.lastType = obs.type
      prev.lastActivitySeq = obs.activitySeq
      prev.noReap = Boolean(obs.noReap) // allow opt-in/out mid-life
      if (obs.createdAt !== undefined) prev.createdAt = obs.createdAt
    }

    // Drop any session no longer present in the snapshot.
    for (const id of Array.from(this.state.keys())) {
      if (!seenIds.has(id)) this.state.delete(id)
    }
  }

  /**
   * Returns the ids of sessions that should be aborted. Pure — no side effects.
   */
  findStuck(): string[] {
    const now = this.now()
    const stuck: string[] = []

    for (const s of this.state.values()) {
      if (s.lastType === 'idle') continue // healthy
      if (s.noReap) continue // explicit opt-out
      const ageRef = s.createdAt ?? s.firstSeenAt
      if (now - ageRef < this.minAgeMs) continue // warm-up window
      if (now - s.lastActivityAt < this.idleMs) continue // still showing activity
      stuck.push(s.sessionId)
    }

    this.lastScanAt = now
    this.lastStuck = stuck
    return stuck
  }

  snapshot(): ReaperSnapshot {
    return {
      trackedSessions: this.state.size,
      stuckSessions: [...this.lastStuck],
      lastScanAt: this.lastScanAt,
      options: { idleMs: this.idleMs, minAgeMs: this.minAgeMs },
    }
  }
}
