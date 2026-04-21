import { describe, expect, it } from 'bun:test'
import { StuckSessionRunner } from '../../src/services/stuck-session-runner'

function makeFakeFetch(routes: {
  status: () => Record<string, { type?: string; activity?: number }>
  sessions: () => Array<{ id: string; time?: { created?: number }; metadata?: { noReap?: boolean } }>
  aborts: string[]
  fail?: { status?: boolean; sessions?: boolean; abort?: boolean }
}) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    if (url.endsWith('/session/status')) {
      if (routes.fail?.status) throw new Error('upstream boom')
      return new Response(JSON.stringify(routes.status()), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.endsWith('/session')) {
      if (routes.fail?.sessions) throw new Error('sessions boom')
      return new Response(JSON.stringify(routes.sessions()), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const m = url.match(/\/session\/([^/]+)\/abort$/)
    if (m && init?.method === 'POST') {
      if (routes.fail?.abort) throw new Error('abort boom')
      routes.aborts.push(m[1])
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('not found', { status: 404 })
  }
}

describe('StuckSessionRunner', () => {
  it('does not abort anything when no sessions are stuck', async () => {
    const aborts: string[] = []
    const now = { t: 1_000_000 }
    const runner = new StuckSessionRunner({
      baseUrl: 'http://oc.test',
      idleMs: 1000,
      minAgeMs: 100,
      fetchImpl: makeFakeFetch({
        status: () => ({ 's1': { type: 'busy', activity: 1 } }),
        sessions: () => [{ id: 's1', time: { created: now.t - 200 } }],
        aborts,
      }) as typeof fetch,
      now: () => now.t,
    })

    await runner.tick()
    expect(aborts).toEqual([])
    expect(runner.snapshot().lastAbortedIds).toEqual([])
  })

  it('aborts a session that has been busy AND silent for idleMs', async () => {
    const aborts: string[] = []
    const now = { t: 1_000_000 }
    const runner = new StuckSessionRunner({
      baseUrl: 'http://oc.test',
      idleMs: 1000,
      minAgeMs: 100,
      fetchImpl: makeFakeFetch({
        status: () => ({ 's1': { type: 'busy', activity: 1 } }),
        sessions: () => [{ id: 's1', time: { created: now.t - 10_000 } }],
        aborts,
      }) as typeof fetch,
      now: () => now.t,
    })

    // First tick: initial observation, nothing stuck yet.
    await runner.tick()
    expect(aborts).toEqual([])

    // 2s later, still busy, same activity seq → stuck.
    now.t += 2_000
    await runner.tick()
    expect(aborts).toEqual(['s1'])
    expect(runner.snapshot().lastAbortedIds).toEqual(['s1'])
  })

  it('does not abort a session marked noReap, regardless of idle time', async () => {
    const aborts: string[] = []
    const now = { t: 1_000_000 }
    const runner = new StuckSessionRunner({
      baseUrl: 'http://oc.test',
      idleMs: 1000,
      minAgeMs: 100,
      fetchImpl: makeFakeFetch({
        status: () => ({ 's1': { type: 'busy', activity: 1 } }),
        sessions: () => [{ id: 's1', time: { created: now.t - 10_000 }, metadata: { noReap: true } }],
        aborts,
      }) as typeof fetch,
      now: () => now.t,
    })

    await runner.tick()
    now.t += 10_000
    await runner.tick()
    expect(aborts).toEqual([])
  })

  it('records lastError on upstream failure and does not crash', async () => {
    const aborts: string[] = []
    const runner = new StuckSessionRunner({
      baseUrl: 'http://oc.test',
      fetchImpl: makeFakeFetch({
        status: () => ({}),
        sessions: () => [],
        aborts,
        fail: { status: true },
      }) as typeof fetch,
    })
    await runner.tick()
    expect(runner.snapshot().lastError).toBeTruthy()
    expect(aborts).toEqual([])
  })

  it('exposes a stable snapshot shape for /kortix/health surfacing', async () => {
    const runner = new StuckSessionRunner({
      baseUrl: 'http://oc.test',
      fetchImpl: makeFakeFetch({
        status: () => ({}),
        sessions: () => [],
        aborts: [],
      }) as typeof fetch,
    })
    await runner.tick()
    const snap = runner.snapshot()
    expect(snap).toHaveProperty('reaper')
    expect(snap.reaper).toHaveProperty('trackedSessions')
    expect(snap.reaper).toHaveProperty('options')
    expect(snap.reaper.options).toHaveProperty('idleMs')
    expect(snap.reaper.options).toHaveProperty('minAgeMs')
    expect(snap).toHaveProperty('lastScanAt')
    expect(snap).toHaveProperty('lastAbortedIds')
    expect(snap).toHaveProperty('lastError')
  })
})
