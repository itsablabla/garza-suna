/**
 * StuckSessionRunner — periodic ticker that drives the StuckSessionReaper.
 *
 * Every `scanIntervalMs` it:
 *   1. GETs http://OPENCODE/session/status     → Record<sessionId, {type, ...}>
 *   2. GETs http://OPENCODE/session            → Array<{id, time:{created, updated}, metadata?}>
 *      (for createdAt + noReap opt-out lookup)
 *   3. Feeds both into reaper.observe()
 *   4. Posts /session/:id/abort for each id returned by reaper.findStuck()
 *
 * This is intentionally conservative — every step is best-effort, a single
 * transient fetch error just skips the tick. The reaper's activity-based
 * detection handles the rest.
 *
 * The runner is only started when `KORTIX_SESSION_REAPER_ENABLED=true`.
 */

import { StuckSessionReaper, type SessionObservation, type ReaperSnapshot } from './stuck-session-reaper'
import { config } from '../config'

interface OpenCodeSessionStatus {
  type?: string
  activity?: { seq?: number } | number
}

interface OpenCodeSession {
  id: string
  time?: { created?: number; updated?: number }
  metadata?: { noReap?: boolean; [k: string]: unknown }
}

export interface RunnerOptions {
  baseUrl?: string
  scanIntervalMs?: number
  idleMs?: number
  minAgeMs?: number
  fetchImpl?: typeof fetch
  now?: () => number
}

export class StuckSessionRunner {
  private readonly baseUrl: string
  private readonly scanIntervalMs: number
  private readonly fetchImpl: typeof fetch
  private readonly reaper: StuckSessionReaper
  private timer: ReturnType<typeof setInterval> | null = null
  private lastScanAt: number | null = null
  private lastAbortedIds: string[] = []
  private lastError: string | null = null

  constructor(opts: RunnerOptions = {}) {
    this.baseUrl = opts.baseUrl ?? `http://${config.OPENCODE_HOST}:${config.OPENCODE_PORT}`
    this.scanIntervalMs = opts.scanIntervalMs ?? config.KORTIX_SESSION_SCAN_INTERVAL_MS
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.reaper = new StuckSessionReaper({
      idleMs: opts.idleMs ?? config.KORTIX_SESSION_IDLE_MS,
      minAgeMs: opts.minAgeMs ?? config.KORTIX_SESSION_MIN_AGE_MS,
      now: opts.now,
    })
  }

  start(): void {
    if (this.timer) return
    // Fire once immediately so the first /kortix/health after boot has data,
    // then on the configured cadence.
    void this.tick()
    this.timer = setInterval(() => { void this.tick() }, this.scanIntervalMs)
    // Node/Bun: don't keep the process alive just for this.
    const t = this.timer as unknown as { unref?: () => void }
    if (typeof t.unref === 'function') t.unref()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** One reaper cycle. Exposed for tests. */
  async tick(): Promise<void> {
    try {
      const [statuses, sessions] = await Promise.all([
        this.fetchJson<Record<string, OpenCodeSessionStatus>>('/session/status'),
        this.fetchJson<OpenCodeSession[]>('/session').catch(() => [] as OpenCodeSession[]),
      ])
      this.lastScanAt = Date.now()

      const sessionById = new Map<string, OpenCodeSession>()
      for (const s of sessions || []) if (s?.id) sessionById.set(s.id, s)

      const observations: SessionObservation[] = []
      for (const [sessionId, status] of Object.entries(statuses || {})) {
        const meta = sessionById.get(sessionId)
        const activitySeq = extractActivitySeq(status)
        observations.push({
          sessionId,
          type: status.type || 'idle',
          activitySeq,
          noReap: Boolean(meta?.metadata?.noReap),
          createdAt: meta?.time?.created,
        })
      }

      this.reaper.observe(observations)
      const stuck = this.reaper.findStuck()

      if (stuck.length > 0) {
        await this.abortSessions(stuck)
        this.lastAbortedIds = stuck
      } else {
        this.lastAbortedIds = []
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

  private async abortSessions(ids: string[]): Promise<void> {
    await Promise.all(
      ids.map(async (id) => {
        try {
          await this.fetchImpl(`${this.baseUrl}/session/${id}/abort`, {
            method: 'POST',
            signal: AbortSignal.timeout(3_000),
          })
        } catch {
          // best-effort — the next tick will re-observe and retry.
        }
      }),
    )
  }

  snapshot(): {
    reaper: ReaperSnapshot
    lastScanAt: number | null
    lastAbortedIds: string[]
    lastError: string | null
  } {
    return {
      reaper: this.reaper.snapshot(),
      lastScanAt: this.lastScanAt,
      lastAbortedIds: this.lastAbortedIds,
      lastError: this.lastError,
    }
  }
}

function extractActivitySeq(status: OpenCodeSessionStatus): number {
  // OpenCode's session status shape varies; the activity seq may live at
  // `.activity.seq`, `.activity` (number), or be absent. We just need a
  // monotonic-ish scalar — any of these work; fall back to 0.
  const a = status.activity
  if (typeof a === 'number') return a
  if (a && typeof a === 'object' && typeof a.seq === 'number') return a.seq
  return 0
}

// Lazy singleton so the runner can be shared with /kortix/health.
let singleton: StuckSessionRunner | null = null

export function getStuckSessionRunner(): StuckSessionRunner {
  if (!singleton) singleton = new StuckSessionRunner()
  return singleton
}

export function resetStuckSessionRunner(): void {
  if (singleton) singleton.stop()
  singleton = null
}
