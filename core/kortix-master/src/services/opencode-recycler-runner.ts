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
 *      serviceManager.restartService('opencode-serve') and marks the
 *      recycler on success.
 *
 * IMPORTANT: we use restartService(), NOT requestRecovery(). requestRecovery
 * short-circuits with "already healthy" when the service passes its health
 * check — which a stale-but-not-yet-wedged opencode-serve always does. The
 * whole point of this primitive is to restart a process that is currently
 * healthy but approaching the wedge threshold, so we need an unconditional
 * stop+start. (See Devin Review finding on PR #8.)
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

interface RestartResult {
  ok: boolean
  output?: string
}

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
  /**
   * Overridable for tests. Default: serviceManager.restartService.
   * Must perform an unconditional stop+start — NOT a healthcheck-gated
   * recovery — because the recycler's whole purpose is to restart a
   * currently-healthy process.
   */
  restartService?: (id: string) => Promise<RestartResult>
  /** Overridable for tests. Default: serviceManager.getService. */
  getServingSince?: () => Promise<number | null>
}

export class OpenCodeRecyclerRunner {
  private readonly baseUrl: string
  private readonly scanIntervalMs: number
  private readonly fetchImpl: typeof fetch
  private readonly recycler: OpenCodeRecycler
  private readonly restartServiceFn: (id: string) => Promise<RestartResult>
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
    this.restartServiceFn =
      opts.restartService ??
      (async (id) => {
        const r = await serviceManager.restartService(id)
        return { ok: r.ok, output: r.output }
      })
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
        this.lastRecycleReason = `recycler:${decision.reason}`
        const result = await this.restartServiceFn('opencode-serve')
        // Only enter cooldown when the restart actually succeeded. If it
        // failed, leave `lastRecycleAt` null so the next tick can retry —
        // otherwise a flaky respawn would hide behind a 1h cooldown while
        // the wedge window opens.
        if (result.ok) {
          this.recycler.markRecycled()
          this.lastError = null
        } else {
          this.lastError = `restart failed: ${result.output ?? 'unknown'}`
        }
      } else {
        this.lastError = null
      }
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
