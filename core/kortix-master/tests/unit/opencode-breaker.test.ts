import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { proxyToOpenCode } from '../../src/services/proxy'
import { openCodeBreaker } from '../../src/services/opencode-breaker'
import { serviceManager } from '../../src/services/service-manager'
import { config } from '../../src/config'

describe('openCodeBreaker integration with proxyToOpenCode', () => {
  let app: Hono
  const originalFetch = globalThis.fetch
  const originalRecovery = serviceManager.requestRecovery.bind(serviceManager)
  const originalFlag = config.KORTIX_CIRCUIT_BREAKER_ENABLED
  const originalThreshold = config.KORTIX_CIRCUIT_BREAKER_FAILURE_THRESHOLD
  const originalCooldown = config.KORTIX_CIRCUIT_BREAKER_COOLDOWN_MS

  beforeEach(() => {
    app = new Hono()
    app.all('*', proxyToOpenCode)
    ;(config as { KORTIX_CIRCUIT_BREAKER_ENABLED: boolean }).KORTIX_CIRCUIT_BREAKER_ENABLED = true
    ;(config as { KORTIX_CIRCUIT_BREAKER_FAILURE_THRESHOLD: number }).KORTIX_CIRCUIT_BREAKER_FAILURE_THRESHOLD = 2
    ;(config as { KORTIX_CIRCUIT_BREAKER_COOLDOWN_MS: number }).KORTIX_CIRCUIT_BREAKER_COOLDOWN_MS = 60_000
    openCodeBreaker.reset()
    serviceManager.requestRecovery = (async () => ({ ok: true, output: 'recovered' })) as typeof serviceManager.requestRecovery
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    serviceManager.requestRecovery = originalRecovery
    ;(config as { KORTIX_CIRCUIT_BREAKER_ENABLED: boolean }).KORTIX_CIRCUIT_BREAKER_ENABLED = originalFlag
    ;(config as { KORTIX_CIRCUIT_BREAKER_FAILURE_THRESHOLD: number }).KORTIX_CIRCUIT_BREAKER_FAILURE_THRESHOLD = originalThreshold
    ;(config as { KORTIX_CIRCUIT_BREAKER_COOLDOWN_MS: number }).KORTIX_CIRCUIT_BREAKER_COOLDOWN_MS = originalCooldown
    openCodeBreaker.reset()
  })

  it('fast-fails with 503 "recovering" once threshold failures have accumulated', async () => {
    // Fail every upstream call to drive the breaker open.
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/session')) throw new Error('ECONNREFUSED')
      throw new Error('ECONNREFUSED')
    }) as typeof fetch

    // Two 502s = threshold reached → breaker open.
    await app.request('http://localhost/global/health')
    await app.request('http://localhost/global/health')
    expect(openCodeBreaker.snapshot().state).toBe('open')

    // Next request fast-fails — upstream fetch is NOT called.
    let upstreamCalls = 0
    globalThis.fetch = (async () => {
      upstreamCalls += 1
      throw new Error('should not be called')
    }) as typeof fetch

    const res = await app.request('http://localhost/global/health')
    expect(res.status).toBe(503)
    const body = await res.json() as { error: string; breaker: { state: string } }
    expect(body.error).toBe('OpenCode recovering')
    expect(body.breaker.state).toBe('open')
    expect(upstreamCalls).toBe(0)
  })

  it('does NOT fast-fail /file/status — that path always hits upstream', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/session')) throw new Error('ECONNREFUSED')
      throw new Error('ECONNREFUSED')
    }) as typeof fetch

    // Drive breaker open via a different path.
    await app.request('http://localhost/global/health')
    await app.request('http://localhost/global/health')
    expect(openCodeBreaker.snapshot().state).toBe('open')

    // /file/status should still attempt upstream (returns 504 from timeout path).
    let fileStatusCalls = 0
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/session')) throw new Error('ECONNREFUSED')
      if (url.includes('/file/status')) {
        fileStatusCalls += 1
        throw new DOMException('timed out', 'TimeoutError')
      }
      throw new Error('ECONNREFUSED')
    }) as typeof fetch

    const res = await app.request('http://localhost/file/status')
    expect(res.status).toBe(504)
    expect(fileStatusCalls).toBe(1)
  })

  it('does nothing when the flag is disabled, regardless of failure count', async () => {
    ;(config as { KORTIX_CIRCUIT_BREAKER_ENABLED: boolean }).KORTIX_CIRCUIT_BREAKER_ENABLED = false

    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as typeof fetch

    // Many failures — should never trip.
    for (let i = 0; i < 10; i++) {
      await app.request('http://localhost/global/health')
    }

    // canProceed always returns true when flag is off.
    expect(openCodeBreaker.canProceed()).toBe(true)
  })

  it('onSuccess from a 2xx response closes an open breaker after cooldown', async () => {
    // Singleton enforces a 1000ms minimum cooldown floor. Use 1000ms here and
    // wait slightly over that; the half-open → closed transition is also
    // covered by pure unit tests in circuit-breaker.test.ts.
    ;(config as { KORTIX_CIRCUIT_BREAKER_COOLDOWN_MS: number }).KORTIX_CIRCUIT_BREAKER_COOLDOWN_MS = 1000
    openCodeBreaker.reset()

    globalThis.fetch = (async () => { throw new Error('ECONNREFUSED') }) as typeof fetch
    await app.request('http://localhost/global/health')
    await app.request('http://localhost/global/health')
    expect(openCodeBreaker.snapshot().state).toBe('open')

    await new Promise((r) => setTimeout(r, 1100))

    // Next call gets a 200 → breaker closes.
    globalThis.fetch = (async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
    const res = await app.request('http://localhost/global/health')
    expect(res.status).toBe(200)
    expect(openCodeBreaker.snapshot().state).toBe('closed')
  })
})
