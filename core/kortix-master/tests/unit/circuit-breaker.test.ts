import { describe, expect, it } from 'bun:test'
import { CircuitBreaker } from '../../src/services/circuit-breaker'

function makeClock(initial = 0) {
  let t = initial
  return {
    now: () => t,
    advance: (ms: number) => { t += ms },
    set: (ms: number) => { t = ms },
  }
}

describe('CircuitBreaker', () => {
  it('starts closed and allows traffic through', () => {
    const cb = new CircuitBreaker({ name: 'test', failureThreshold: 3, cooldownMs: 1000 })
    expect(cb.canProceed()).toBe(true)
    expect(cb.snapshot().state).toBe('closed')
  })

  it('trips to open after failureThreshold consecutive failures', () => {
    const clock = makeClock()
    const cb = new CircuitBreaker({ name: 'test', failureThreshold: 3, cooldownMs: 1000, now: clock.now })

    cb.onFailure(); cb.onFailure()
    expect(cb.snapshot().state).toBe('closed')
    expect(cb.canProceed()).toBe(true)

    cb.onFailure()
    expect(cb.snapshot().state).toBe('open')
    expect(cb.canProceed()).toBe(false)
  })

  it('resets the failure counter on success', () => {
    const cb = new CircuitBreaker({ name: 'test', failureThreshold: 3, cooldownMs: 1000 })
    cb.onFailure(); cb.onFailure()
    cb.onSuccess()
    cb.onFailure(); cb.onFailure()
    expect(cb.snapshot().state).toBe('closed')
    expect(cb.canProceed()).toBe(true)
  })

  it('transitions open → half-open after cooldown elapses and allows one probe', () => {
    const clock = makeClock(10_000)
    const cb = new CircuitBreaker({ name: 'test', failureThreshold: 2, cooldownMs: 5000, now: clock.now })

    cb.onFailure(); cb.onFailure()
    expect(cb.snapshot().state).toBe('open')

    clock.advance(4999)
    expect(cb.canProceed()).toBe(false) // still open
    expect(cb.snapshot().state).toBe('open')

    clock.advance(2) // cooldown elapsed
    expect(cb.canProceed()).toBe(true) // probe allowed
    expect(cb.snapshot().state).toBe('half-open')

    // second concurrent check during probe → blocked
    expect(cb.canProceed()).toBe(false)
  })

  it('closes on successful probe', () => {
    const clock = makeClock()
    const cb = new CircuitBreaker({ name: 'test', failureThreshold: 2, cooldownMs: 100, now: clock.now })

    cb.onFailure(); cb.onFailure()
    clock.advance(101)
    cb.canProceed() // → half-open
    cb.onSuccess()
    expect(cb.snapshot().state).toBe('closed')
    expect(cb.snapshot().consecutiveFailures).toBe(0)
  })

  it('re-opens on failed probe and resets the cooldown window', () => {
    const clock = makeClock()
    const cb = new CircuitBreaker({ name: 'test', failureThreshold: 2, cooldownMs: 100, now: clock.now })

    cb.onFailure(); cb.onFailure()
    clock.advance(101)
    cb.canProceed() // → half-open
    cb.onFailure()
    expect(cb.snapshot().state).toBe('open')

    clock.advance(50)
    expect(cb.canProceed()).toBe(false)
    clock.advance(51)
    expect(cb.canProceed()).toBe(true)
  })

  it('exposes a stable snapshot shape for health surfacing', () => {
    const cb = new CircuitBreaker({ name: 'opencode-message', failureThreshold: 3, cooldownMs: 10_000 })
    const snap = cb.snapshot()
    expect(snap.name).toBe('opencode-message')
    expect(snap.state).toBe('closed')
    expect(snap.consecutiveFailures).toBe(0)
    expect(snap.openedAt).toBeNull()
    expect(snap.lastFailureAt).toBeNull()
    expect(snap.lastSuccessAt).toBeNull()
  })

  it('rejects invalid config', () => {
    expect(() => new CircuitBreaker({ name: 't', failureThreshold: 0, cooldownMs: 1000 })).toThrow()
    expect(() => new CircuitBreaker({ name: 't', failureThreshold: 3, cooldownMs: 0 })).toThrow()
  })
})
