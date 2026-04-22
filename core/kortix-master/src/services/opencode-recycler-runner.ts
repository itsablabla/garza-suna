/**
 * OpenCodeRecyclerRunner — periodic ticker that drives OpenCodeRecycler.
 *
 * Every `scanIntervalMs` it:
 *   1. Reads the opencode-serve service snapshot from ServiceManager
 *      (for startedAt).
 *   2. GETs http://OPENCODE/session/status → counts sessions whose
 *      status.type !== 'idle'.
 *   3. Feeds the tuple into recycler.observe().
 *   4. If recycler.shouldRecycle() returns true, fires
 *      serviceManager.requestRecovery('opencode-serve', 'recycler:idle-age')
 *      and marks the recycler.
 *
 * Best-effort: a transient fetch error or missing snapshot just skips the
 * tick. The recycler's cooldown prevents thrash if the respawn itself is
 * slow.
 *
 * The runner is only started when `KORTIX_OPENCODE_RECYCLER_ENABLED=true`.
 */

import { OpenCodeRecycler, type RecyclerSnapshot } from './opencode-recycler'
import { serviceManager } from './service-manager'
import { config } from '../config'

interface OpenCodeSessionStatus {
  type?: string
}

export interface RunnerOptions {
  baseUrl?: string
  scanIntervalMs?: number
  maxAgeMs?: number
  minIntervalMs?: number
  fetchImpl?: typeof fetch
  now?: () => number
  /** Overridable for tests. Default: serviceManager.requestRecovery. */
  requestRecovery?: (id: string, reason: string) => Promise<unknown>
  /** Overridable for tests. Default: serviceManager.getService. */
  getServingSince?: () => Promise<number | null>
}

export class OpenCodeRecyclerRunner {
  private readonly baseUrl: string
  private readonly scanIntervalMs: number
  private readonly fetchImpl: typeof fetch
  private readonly recycler: OpenCodeRecycler
  private readonly requestRecoveryFn: (id: string, reason: string) => Promise<unknown>
  private readonly getServingSinceFn: () => Promise<number | null>
  private timer: ReturnType<typeof setInterval> | null = null
  private lastScanAt: number | null = null
  private lastError: string | null = null
  private lastRecycleReason: string | null = null

  constructor(opts: RunnerOptions = {}) {
    this.baseUrl = opts.baseUrl ?? `http://${config.OPENCODE_HOST}:${config.OPENCODE_PORT}`
    this.scanIntervalMs = opts.scanIntervalMs ?? config.KORTIX_OPENCODE_RECYCLER_SCAN_INTERVAL_MS
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.recycler = new OpenCodeRecycler({
      maxAgeMs: opts.maxAgeMs ?? config.KORTIX_OPENCODE_RECYCLER_MAX_AGE_MS,
      minIntervalMs: opts.minIntervalMs ?? config.KORTIX_OPENCODE_RECYCLER_MIN_INTERVAL_MS,
      now: opts.now,
    })
    this.requestRecoveryFn =
      opts.requestRecovery ?? ((id, reason) => serviceManager.requestRecovery(id, reason))
    this.getServingSinceFn =
      opts.getServingSince ??
      (async () => {
        const snap = await serviceManager.getService('opencode-serve')
        if (!snap || !snap.startedAt) return null
        const t = Date.parse(snap.startedAt)
        return Number.isFinite(t) ? t : null
      })
  }

  start(): void {
    if (this.timer) return
    void this.tick()
    this.timer = setInterval(() => { void this.tick() }, this.scanIntervalMs)
    const t = this.timer as unknown as { unref?: () => void }
    if (typeof t.unref === 'function') t.unref()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** One recycler cycle. Exposed for tests. */
  async tick(): Promise<void> {
    try {
      const servingSinceMs = await this.getServingSinceFn()
      this.lastScanAt = Date.now()
      if (servingSinceMs == null) {
        // Service has never started, or just died and is in mid-respawn.
        // Skip — there is nothing to recycle.
        this.lastError = null
        return
      }

      const statuses = await this.fetchJson<Record<string, OpenCodeSessionStatus>>('/session/status')
      let nonIdleSessionCount = 0
      for (const s of Object.values(statuses || {})) {
        if ((s?.type || 'idle') !== 'idle') nonIdleSessionCount++
      }

      this.recycler.observe({ servingSinceMs, nonIdleSessionCount })
      const decision = this.recycler.shouldRecycle()

      if (decision.should) {
        this.lastRecycleReason = decision.reason
        const result = await this.requestRecoveryFn('opencode-serve', `recycler:${decision.reason}`)
        // Only mark as recycled if the recovery call reported success OR was
        // at least accepted (throttled counts as "we handed it off").
        if (result && typeof result === 'object') {
          this.recycler.markRecycled()
        }
      }

      this.lastError = null
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
    }
  }

  private async fetchJson<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      signal: AbortSignal.timeout(3_000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${path}`)
    return (await res.json()) as T
  }

  snapshot(): {
    recycler: RecyclerSnapshot
    lastScanAt: number | null
    lastError: string | null
    lastRecycleReason: string | null
  } {
    return {
      recycler: this.recycler.snapshot(),
      lastScanAt: this.lastScanAt,
      lastError: this.lastError,
      lastRecycleReason: this.lastRecycleReason,
    }
  }
}

// Lazy singleton — shared with /kortix/health.
let singleton: OpenCodeRecyclerRunner | null = null

export function getOpenCodeRecyclerRunner(): OpenCodeRecyclerRunner {
  if (!singleton) singleton = new OpenCodeRecyclerRunner()
  return singleton
}

export function resetOpenCodeRecyclerRunner(): void {
  if (singleton) singleton.stop()
  singleton = null
}
