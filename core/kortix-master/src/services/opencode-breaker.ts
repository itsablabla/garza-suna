/**
 * Singleton circuit-breaker for the OpenCode upstream.
 *
 * proxy.ts records success/failure via onSuccess/onFailure and asks
 * canProceed() before dispatch. The /kortix/health route reads snapshot()
 * and surfaces "recovering" when the breaker is open, so clients can
 * render a "recovering…" pill instead of "Unreachable Xs".
 *
 * This is a lazy singleton — the underlying CircuitBreaker is created the
 * first time it's accessed so tests can construct a fresh one via reset().
 */

import { CircuitBreaker, type BreakerSnapshot } from './circuit-breaker'
import { config } from '../config'

let breaker: CircuitBreaker | null = null

function instance(): CircuitBreaker {
  if (!breaker) {
    breaker = new CircuitBreaker({
      name: 'opencode-proxy',
      failureThreshold: Math.max(1, config.KORTIX_CIRCUIT_BREAKER_FAILURE_THRESHOLD),
      cooldownMs: Math.max(1000, config.KORTIX_CIRCUIT_BREAKER_COOLDOWN_MS),
    })
  }
  return breaker
}

export const openCodeBreaker = {
  canProceed(): boolean {
    if (!config.KORTIX_CIRCUIT_BREAKER_ENABLED) return true
    return instance().canProceed()
  },
  onSuccess(): void {
    instance().onSuccess()
  },
  onFailure(): void {
    instance().onFailure()
  },
  snapshot(): BreakerSnapshot {
    return instance().snapshot()
  },
  /** Test-only: discard singleton so the next access re-reads config. */
  reset(): void {
    breaker = null
  },
}
