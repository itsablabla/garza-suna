import { describe, expect, it } from 'bun:test'
import { StuckSessionReaper } from '../../src/services/stuck-session-reaper'

function makeClock(initial = 0) {
  let t = initial
  return { now: () => t, advance: (ms: number) => { t += ms }, set: (ms: number) => { t = ms } }
}

describe('StuckSessionReaper', () => {
  it('never flags an idle session, no matter how long', () => {
    const clock = makeClock()
    const r = new StuckSessionReaper({ idleMs: 1000, minAgeMs: 0, now: clock.now })
    r.observe([{ sessionId: 'a', type: 'idle', createdAt: 0 }])
    clock.advance(10_000_000)
    r.observe([{ sessionId: 'a', type: 'idle', createdAt: 0 }])
    expect(r.findStuck()).toEqual([])
  })

  it('does NOT flag a busy session that is emitting activity signals', () => {
    // Golden-path: an autonomous agent doing a long tool chain.
    const clock = makeClock()
    const r = new StuckSessionReaper({ idleMs: 600_000, minAgeMs: 0, now: clock.now })

    // Observe every 30s for 20 minutes, with monotonically increasing activitySeq.
    let seq = 0
    for (let elapsed = 0; elapsed < 20 * 60_000; elapsed += 30_000) {
      clock.set(elapsed)
      r.observe([{ sessionId: 'agent-1', type: 'busy', activitySeq: seq++, createdAt: 0 }])
      expect(r.findStuck()).toEqual([])
    }
  })

  it('flags a busy session that has emitted zero activity for idleMs', () => {
    const clock = makeClock()
    const r = new StuckSessionReaper({ idleMs: 600_000, minAgeMs: 60_000, now: clock.now })

    // Session starts busy at t=0.
    clock.set(0)
    r.observe([{ sessionId: 'wedged', type: 'busy', activitySeq: 'x', createdAt: 0 }])
    expect(r.findStuck()).toEqual([])

    // Still busy 10min later, still the same activitySeq → wedged.
    clock.set(600_001)
    r.observe([{ sessionId: 'wedged', type: 'busy', activitySeq: 'x', createdAt: 0 }])
    expect(r.findStuck()).toEqual(['wedged'])
  })

  it('respects the minAgeMs warm-up gate', () => {
    const clock = makeClock()
    const r = new StuckSessionReaper({ idleMs: 100, minAgeMs: 60_000, now: clock.now })

    // Brand-new session appears — no activitySeq yet, no history.
    clock.set(500_000)
    r.observe([{ sessionId: 'baby', type: 'busy', createdAt: 500_000 }])

    // Well past idleMs, but still inside warm-up window.
    clock.set(500_000 + 10_000)
    r.observe([{ sessionId: 'baby', type: 'busy', createdAt: 500_000 }])
    expect(r.findStuck()).toEqual([])

    // Past warm-up window now → flagged.
    clock.set(500_000 + 60_001)
    r.observe([{ sessionId: 'baby', type: 'busy', createdAt: 500_000 }])
    expect(r.findStuck()).toEqual(['baby'])
  })

  it('never flags a session marked noReap, regardless of idle duration', () => {
    const clock = makeClock()
    const r = new StuckSessionReaper({ idleMs: 100, minAgeMs: 0, now: clock.now })

    r.observe([{ sessionId: 'deep-research', type: 'busy', activitySeq: 'q', noReap: true, createdAt: 0 }])
    clock.advance(10 * 60 * 60 * 1000) // 10 hours
    r.observe([{ sessionId: 'deep-research', type: 'busy', activitySeq: 'q', noReap: true, createdAt: 0 }])
    expect(r.findStuck()).toEqual([])
  })

  it('drops sessions that disappear from the snapshot', () => {
    const r = new StuckSessionReaper({ idleMs: 100, minAgeMs: 0 })
    r.observe([{ sessionId: 'a', type: 'busy' }, { sessionId: 'b', type: 'busy' }])
    expect(r.snapshot().trackedSessions).toBe(2)
    r.observe([{ sessionId: 'a', type: 'busy' }])
    expect(r.snapshot().trackedSessions).toBe(1)
  })

  it('clears activity timestamp on status transition', () => {
    // busy → idle → busy should reset the activity clock, so a session that
    // alternated between states isn't immediately flagged after returning to busy.
    const clock = makeClock()
    const r = new StuckSessionReaper({ idleMs: 1000, minAgeMs: 0, now: clock.now })

    clock.set(0)
    r.observe([{ sessionId: 's', type: 'busy', activitySeq: 1, createdAt: 0 }])
    clock.set(2000)
    r.observe([{ sessionId: 's', type: 'idle', activitySeq: 1, createdAt: 0 }]) // status change bumps activity
    clock.set(2500)
    r.observe([{ sessionId: 's', type: 'busy', activitySeq: 1, createdAt: 0 }]) // status change bumps activity
    clock.set(3000) // only 500ms since last activity
    r.observe([{ sessionId: 's', type: 'busy', activitySeq: 1, createdAt: 0 }])
    expect(r.findStuck()).toEqual([])
  })

  it('snapshot() exposes stable shape for /kortix/health surfacing', () => {
    const r = new StuckSessionReaper({ idleMs: 600_000, minAgeMs: 60_000 })
    const snap = r.snapshot()
    expect(snap.trackedSessions).toBe(0)
    expect(snap.stuckSessions).toEqual([])
    expect(snap.lastScanAt).toBeNull()
    expect(snap.options).toEqual({ idleMs: 600_000, minAgeMs: 60_000 })
  })
})
