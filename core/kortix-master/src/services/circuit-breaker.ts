/**
 * Generic circuit-breaker primitive.
 *
 * States:
 *   - closed:    normal operation. Every failure increments the counter;
 *                after `failureThreshold` consecutive failures → open.
 *   - open:      fast-fail every call for `cooldownMs`. No upstream request.
 *   - half-open: allow one probe; success → closed, failure → open again.
 *
 * This is a pure primitive — no I/O, no timers, no globals. Consumers
 * call `canProceed()` before dispatch, `onSuccess()` after 2xx/3xx, and
 * `onFailure()` after a timeout or 5xx. Clock is injected for testability.
 */

export type BreakerState = 'closed' | 'open' | 'half-open'

export interface BreakerSnapshot {
  name: string
  state: BreakerState
  consecutiveFailures: number
  openedAt: number | null
  lastFailureAt: number | null
  lastSuccessAt: number | null
}

export interface BreakerOptions {
  name: string
  failureThreshold: number
  cooldownMs: number
  now?: () => number
}

export class CircuitBreaker {
  private readonly name: string
  private readonly failureThreshold: number
  private readonly cooldownMs: number
  private readonly now: () => number

  private state: BreakerState = 'closed'
  private consecutiveFailures = 0
  private openedAt: number | null = null
  private lastFailureAt: number | null = null
  private lastSuccessAt: number | null = null

  constructor(opts: BreakerOptions) {
    if (opts.failureThreshold <= 0) {
      throw new Error('failureThreshold must be > 0')
    }
    if (opts.cooldownMs <= 0) {
      throw new Error('cooldownMs must be > 0')
    }
    this.name = opts.name
    this.failureThreshold = opts.failureThreshold
    this.cooldownMs = opts.cooldownMs
    this.now = opts.now ?? Date.now
  }

  /**
   * Returns true if the call should proceed. When open, transitions to
   * half-open once the cooldown has elapsed and allows exactly one probe.
   */
  canProceed(): boolean {
    if (this.state === 'closed') return true
    if (this.state === 'half-open') return false // a probe is already in flight
    // open
    if (this.openedAt !== null && this.now() - this.openedAt >= this.cooldownMs) {
      this.state = 'half-open'
      return true
    }
    return false
  }

  onSuccess(): void {
    this.consecutiveFailures = 0
    this.openedAt = null
    this.state = 'closed'
    this.lastSuccessAt = this.now()
  }

  onFailure(): void {
    this.consecutiveFailures += 1
    this.lastFailureAt = this.now()
    if (this.state === 'half-open') {
      this.state = 'open'
      this.openedAt = this.now()
      return
    }
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.state = 'open'
      this.openedAt = this.now()
    }
  }

  snapshot(): BreakerSnapshot {
    return {
      name: this.name,
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      openedAt: this.openedAt,
      lastFailureAt: this.lastFailureAt,
      lastSuccessAt: this.lastSuccessAt,
    }
  }
}
