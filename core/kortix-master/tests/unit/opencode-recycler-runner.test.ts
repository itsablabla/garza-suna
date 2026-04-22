import { describe, it, expect, mock } from 'bun:test'
import { OpenCodeRecyclerRunner } from '../../src/services/opencode-recycler-runner'

const HOUR = 60 * 60 * 1000

function mockFetch(map: Record<string, unknown>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url)
    const path = new URL(url).pathname
    if (!(path in map)) {
      return new Response('not found', { status: 404 }) as Response
    }
    return new Response(JSON.stringify(map[path]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }) as Response
  }) as unknown as typeof fetch
}

describe('OpenCodeRecyclerRunner', () => {
  it('skips recycle when opencode-serve snapshot has no startedAt', async () => {
    const requestRecovery = mock(async () => ({ ok: true }))
    const runner = new OpenCodeRecyclerRunner({
      maxAgeMs: 6 * HOUR,
      minIntervalMs: HOUR,
      scanIntervalMs: 60_000,
      getServingSince: async () => null,
      fetchImpl: mockFetch({ '/session/status': {} }),
      requestRecovery,
    })
    await runner.tick()
    expect(requestRecovery).not.toHaveBeenCalled()
    expect(runner.snapshot().lastError).toBeNull()
  })

  it('does not recycle when a session is non-idle', async () => {
    const now = Date.now()
    const requestRecovery = mock(async () => ({ ok: true }))
    const runner = new OpenCodeRecyclerRunner({
      maxAgeMs: 6 * HOUR,
      minIntervalMs: HOUR,
      scanIntervalMs: 60_000,
      getServingSince: async () => now - 7 * HOUR,
      fetchImpl: mockFetch({
        '/session/status': { s1: { type: 'generating' } },
      }),
      requestRecovery,
    })
    await runner.tick()
    expect(requestRecovery).not.toHaveBeenCalled()
    const snap = runner.snapshot()
    expect(snap.recycler.lastDecision?.should).toBe(false)
  })

  it('recycles when uptime exceeds maxAgeMs and all sessions idle', async () => {
    const now = Date.now()
    const requestRecovery = mock(async () => ({ ok: true, output: 'respawned' }))
    const runner = new OpenCodeRecyclerRunner({
      maxAgeMs: 6 * HOUR,
      minIntervalMs: HOUR,
      scanIntervalMs: 60_000,
      getServingSince: async () => now - 7 * HOUR,
      fetchImpl: mockFetch({
        '/session/status': { s1: { type: 'idle' }, s2: { type: 'idle' } },
      }),
      requestRecovery,
    })
    await runner.tick()
    expect(requestRecovery).toHaveBeenCalledTimes(1)
    const [id, reason] = requestRecovery.mock.calls[0]
    expect(id).toBe('opencode-serve')
    expect(reason).toMatch(/^recycler:/)
    const snap = runner.snapshot()
    expect(snap.recycler.lastRecycleAt).not.toBeNull()
  })

  it('records fetch errors on the snapshot but does not crash', async () => {
    const now = Date.now()
    const runner = new OpenCodeRecyclerRunner({
      maxAgeMs: 6 * HOUR,
      minIntervalMs: HOUR,
      scanIntervalMs: 60_000,
      getServingSince: async () => now - 7 * HOUR,
      fetchImpl: (() => { throw new Error('connect ECONNREFUSED') }) as unknown as typeof fetch,
      requestRecovery: async () => ({ ok: true }),
    })
    await runner.tick()
    const snap = runner.snapshot()
    expect(snap.lastError).toContain('ECONNREFUSED')
    expect(snap.recycler.lastRecycleAt).toBeNull()
  })
})
