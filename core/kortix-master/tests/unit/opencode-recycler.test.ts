import { describe, it, expect } from 'bun:test'
import { OpenCodeRecycler } from '../../src/services/opencode-recycler'

const HOUR = 60 * 60 * 1000
const MIN = 60 * 1000

function withClock() {
  let t = 1_000_000
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

describe('OpenCodeRecycler', () => {
  it('rejects invalid options', () => {
    expect(() => new OpenCodeRecycler({ maxAgeMs: 0, minIntervalMs: 0 })).toThrow(/maxAgeMs/)
    expect(() => new OpenCodeRecycler({ maxAgeMs: 1, minIntervalMs: -1 })).toThrow(/minIntervalMs/)
  })

  it('says no when there is no observation yet', () => {
    const r = new OpenCodeRecycler({ maxAgeMs: 6 * HOUR, minIntervalMs: HOUR })
    const d = r.shouldRecycle()
    expect(d.should).toBe(false)
    expect(d.reason).toBe('no-observation-yet')
  })

  it('says no when uptime is below maxAgeMs', () => {
    const clk = withClock()
    const r = new OpenCodeRecycler({ maxAgeMs: 6 * HOUR, minIntervalMs: HOUR, now: clk.now })
    r.observe({ servingSinceMs: clk.now() - 5 * HOUR, nonIdleSessionCount: 0 })
    expect(r.shouldRecycle().should).toBe(false)
  })

  it('says no when a session is non-idle, even past maxAgeMs', () => {
    const clk = withClock()
    const r = new OpenCodeRecycler({ maxAgeMs: 6 * HOUR, minIntervalMs: HOUR, now: clk.now })
    r.observe({ servingSinceMs: clk.now() - 7 * HOUR, nonIdleSessionCount: 1 })
    const d = r.shouldRecycle()
    expect(d.should).toBe(false)
    expect(d.reason).toContain('nonIdleSessionCount=1')
  })

  it('says yes when age is exceeded and all sessions idle', () => {
    const clk = withClock()
    const r = new OpenCodeRecycler({ maxAgeMs: 6 * HOUR, minIntervalMs: HOUR, now: clk.now })
    r.observe({ servingSinceMs: clk.now() - 7 * HOUR, nonIdleSessionCount: 0 })
    const d = r.shouldRecycle()
    expect(d.should).toBe(true)
    expect(d.reason).toMatch(/age.*maxAgeMs/)
  })

  it('enforces cooldown via markRecycled()', () => {
    const clk = withClock()
    const r = new OpenCodeRecycler({ maxAgeMs: 6 * HOUR, minIntervalMs: HOUR, now: clk.now })
    r.observe({ servingSinceMs: clk.now() - 7 * HOUR, nonIdleSessionCount: 0 })
    expect(r.shouldRecycle().should).toBe(true)
    r.markRecycled()

    // Immediately after, cooldown blocks even if fresh observation also idle + old.
    clk.advance(5 * MIN)
    r.observe({ servingSinceMs: clk.now() - 8 * HOUR, nonIdleSessionCount: 0 })
    const blocked = r.shouldRecycle()
    expect(blocked.should).toBe(false)
    expect(blocked.reason).toContain('cooldown')

    // After cooldown elapses, eligible again.
    clk.advance(HOUR)
    r.observe({ servingSinceMs: clk.now() - 9 * HOUR, nonIdleSessionCount: 0 })
    expect(r.shouldRecycle().should).toBe(true)
  })

  it('snapshot reflects last observation + decision + recycle marker', () => {
    const clk = withClock()
    const r = new OpenCodeRecycler({ maxAgeMs: 6 * HOUR, minIntervalMs: HOUR, now: clk.now })
    let snap = r.snapshot()
    expect(snap.lastObservation).toBeNull()
    expect(snap.lastRecycleAt).toBeNull()

    r.observe({ servingSinceMs: clk.now() - 7 * HOUR, nonIdleSessionCount: 0 })
    r.shouldRecycle()
    r.markRecycled()

    snap = r.snapshot()
    expect(snap.lastObservation?.nonIdleSessionCount).toBe(0)
    expect(snap.lastDecision?.should).toBe(true)
    expect(snap.lastRecycleAt).toBe(clk.now())
    expect(snap.options).toEqual({ maxAgeMs: 6 * HOUR, minIntervalMs: HOUR })
  })
})
