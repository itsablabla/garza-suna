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
    const restartService = mock(async () => ({ ok: true }))
    const runner = new OpenCodeRecyclerRunner({
      maxAgeMs: 6 * HOUR,
      minIntervalMs: HOUR,
      scanIntervalMs: 60_000,
      getServingSince: async () => null,
      fetchImpl: mockFetch({ '/session/status': {} }),
      restartService,
    })
    await runner.tick()
    expect(restartService).not.toHaveBeenCalled()
    expect(runner.snapshot().lastError).toBeNull()
  })

  it('does not recycle when a session is non-idle', async () => {
    const now = Date.now()
    const restartService = mock(async () => ({ ok: true }))
    const runner = new OpenCodeRecyclerRunner({
      maxAgeMs: 6 * HOUR,
      minIntervalMs: HOUR,
      scanIntervalMs: 60_000,
      getServingSince: async () => now - 7 * HOUR,
      fetchImpl: mockFetch({
        '/session/status': { s1: { type: 'generating' } },
      }),
      restartService,
    })
    await runner.tick()
    expect(restartService).not.toHaveBeenCalled()
    const snap = runner.snapshot()
    expect(snap.recycler.lastDecision?.should).toBe(false)
  })

  it('recycles when uptime exceeds maxAgeMs and all sessions idle', async () => {
    const now = Date.now()
    const restartService = mock(async () => ({ ok: true, output: 'respawned' }))
    const runner = new OpenCodeRecyclerRunner({
      maxAgeMs: 6 * HOUR,
      minIntervalMs: HOUR,
      scanIntervalMs: 60_000,
      getServingSince: async () => now - 7 * HOUR,
      fetchImpl: mockFetch({
        '/session/status': { s1: { type: 'idle' }, s2: { type: 'idle' } },
      }),
      restartService,
    })
    await runner.tick()
    expect(restartService).toHaveBeenCalledTimes(1)
    const [id] = restartService.mock.calls[0]
    expect(id).toBe('opencode-serve')
    const snap = runner.snapshot()
    expect(snap.recycler.lastRecycleAt).not.toBeNull()
    expect(snap.lastRecycleReason).toMatch(/^recycler:/)
  })

  it('does NOT mark cooldown when restart reports failure (retries next tick)', async () => {
    const now = Date.now()
    const restartService = mock(async () => ({ ok: false, output: 'spawn EACCES' }))
    const runner = new OpenCodeRecyclerRunner({
      maxAgeMs: 6 * HOUR,
      minIntervalMs: HOUR,
      scanIntervalMs: 60_000,
      getServingSince: async () => now - 7 * HOUR,
      fetchImpl: mockFetch({
        '/session/status': { s1: { type: 'idle' } },
      }),
      restartService,
    })
    await runner.tick()
    expect(restartService).toHaveBeenCalledTimes(1)
    const snap = runner.snapshot()
    // Cooldown NOT set → next tick would try again. Critical: flaky respawn
    // must not hide behind a 1h cooldown while the wedge window opens.
    expect(snap.recycler.lastRecycleAt).toBeNull()
    expect(snap.lastError).toContain('spawn EACCES')
  })

  it('records fetch errors on the snapshot but does not crash', async () => {
    const now = Date.now()
    const runner = new OpenCodeRecyclerRunner({
      maxAgeMs: 6 * HOUR,
      minIntervalMs: HOUR,
      scanIntervalMs: 60_000,
      getServingSince: async () => now - 7 * HOUR,
      fetchImpl: (() => { throw new Error('connect ECONNREFUSED') }) as unknown as typeof fetch,
      restartService: async () => ({ ok: true }),
    })
    await runner.tick()
    const snap = runner.snapshot()
    expect(snap.lastError).toContain('ECONNREFUSED')
    expect(snap.recycler.lastRecycleAt).toBeNull()
  })
})
