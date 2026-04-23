/**
 * Prophylactic OpenCode recycler (pure primitive).
 *
 * Motivation: the hosted Kortix sandbox (new-api.kortix.com) runs the same
 * upstream 0.8.44 image we self-host, yet doesn't wedge — because each
 * project sandbox is short-lived (spun up on demand, torn down when idle).
 * Long-running opencode-serve processes accumulate state (SSE sockets,
 * heartbeat timers, model-client buffers) that eventually deadlocks.
 *
 * This primitive mimics the hosted lifecycle cheaply on self-hosted: when
 * opencode-serve has been running > maxAgeMs AND there are zero non-idle
 * sessions, we proactively ask ServiceManager.requestRecovery() to respawn
 * it. The circuit breaker + HTTP health check + watchdog are REACTIVE (fix
 * it after it breaks). This is PREVENTIVE (avoid the break in the first
 * place). It complements — does not replace — those primitives.
 *
 * Strict invariant: recycle ONLY during idle windows. Never interrupt a
 * live session. The `nonIdleSessionCount === 0` gate is the hard safety
 * rail. A cooldown (`minIntervalMs`) prevents thrash if the respawn itself
 * is flaky.
 *
 * Pure primitive: no timers, no I/O. Consumers tick observe() with the
 * current sandbox snapshot, then call shouldRecycle(). The runner owns the
 * interval + the `requestRecovery` side effect.
 */

export interface RecyclerOptions {
  /** ms of uptime before a recycle becomes eligible. Default 21_600_000 (6h). */
  maxAgeMs: number
  /** ms cooldown after a recycle before the next one is eligible. Default 3_600_000 (1h). */
  minIntervalMs: number
  now?: () => number
}

export interface RecyclerObservation {
  /** unix ms when the currently-running opencode-serve process started. */
  servingSinceMs: number
  /** Number of OpenCode sessions whose status.type !== 'idle'. */
  nonIdleSessionCount: number
}

export interface RecyclerDecision {
  should: boolean
  reason: string
}

export interface RecyclerSnapshot {
  enabled: true
  lastObservation: RecyclerObservation | null
  lastRecycleAt: number | null
  lastDecision: RecyclerDecision | null
  options: { maxAgeMs: number; minIntervalMs: number }
}

export class OpenCodeRecycler {
  private readonly maxAgeMs: number
  private readonly minIntervalMs: number
  private readonly now: () => number
  private lastObservation: RecyclerObservation | null = null
  private lastRecycleAt: number | null = null
  private lastDecision: RecyclerDecision | null = null

  constructor(opts: RecyclerOptions) {
    if (opts.maxAgeMs <= 0) throw new Error('maxAgeMs must be > 0')
    if (opts.minIntervalMs < 0) throw new Error('minIntervalMs must be >= 0')
    this.maxAgeMs = opts.maxAgeMs
    this.minIntervalMs = opts.minIntervalMs
    this.now = opts.now ?? Date.now
  }

  observe(obs: RecyclerObservation): void {
    this.lastObservation = { ...obs }
  }

  shouldRecycle(): RecyclerDecision {
    const obs = this.lastObservation
    if (!obs) {
      const d = { should: false, reason: 'no-observation-yet' }
      this.lastDecision = d
      return d
    }

    const now = this.now()
    const uptimeMs = now - obs.servingSinceMs

    if (uptimeMs < this.maxAgeMs) {
      const d = {
        should: false,
        reason: `uptime ${uptimeMs}ms < maxAgeMs ${this.maxAgeMs}ms`,
      }
      this.lastDecision = d
      return d
    }

    if (obs.nonIdleSessionCount > 0) {
      const d = {
        should: false,
        reason: `nonIdleSessionCount=${obs.nonIdleSessionCount}`,
      }
      this.lastDecision = d
      return d
    }

    if (
      this.lastRecycleAt !== null &&
      now - this.lastRecycleAt < this.minIntervalMs
    ) {
      const d = {
        should: false,
        reason: `cooldown ${now - this.lastRecycleAt}ms < minIntervalMs ${this.minIntervalMs}ms`,
      }
      this.lastDecision = d
      return d
    }

    const d = {
      should: true,
      reason: `age ${uptimeMs}ms >= maxAgeMs ${this.maxAgeMs}ms and idle`,
    }
    this.lastDecision = d
    return d
  }

  /** Called by the runner after it has successfully requested a recycle. */
  markRecycled(): void {
    this.lastRecycleAt = this.now()
  }

  snapshot(): RecyclerSnapshot {
    return {
      enabled: true,
      lastObservation: this.lastObservation
        ? { ...this.lastObservation }
        : null,
      lastRecycleAt: this.lastRecycleAt,
      lastDecision: this.lastDecision ? { ...this.lastDecision } : null,
      options: { maxAgeMs: this.maxAgeMs, minIntervalMs: this.minIntervalMs },
    }
  }
}
