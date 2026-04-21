# Phase B.core — Stuck-Session Killer + Circuit-Breaker Spec

_Status: DRAFT — awaiting partner approval before implementation._

## What the partner experienced

Two symptoms on `super.garzaos.online` on 2026-04-21:

1. **"Unreachable Xs" badge** in the UI chat sidebar (see partner screenshot: <ref_file file="/home/ubuntu/attachments/2bb7bb52-348e-4421-91f6-3dca68feb24c/image.png" />).
2. **Chat replies silently stop arriving** mid-session; then at some later point the session resumes.

Evidence from the audit (see <ref_snippet file="/home/ubuntu/garza-suna/docs/audit-2026-04-21/audit-report.md" lines="1-30" />):

```
GET /v1/p/…/kortix/health → 503
GET /session/:id/message → 504 after 32s
[Kortix Master] OpenCode is no longer reachable
[Kortix Master] OpenCode timeout on … after 30s
```

At peak probe: **7 sessions pinned `busy`, sandbox ~200 % CPU, ~1400 PIDs, 5.8 GB RAM**. Five minutes later: `busy=0`, health 200. Not a crash (`RestartCount=0`) — OpenCode is **serializing behind stuck `busy` sessions** until they eventually time out upstream, then it recovers.

## What the spec changes

Two additions in `core/kortix-master/`:

1. **Stuck-session killer** — a periodic worker that detects `busy` sessions that have been idle too long and force-aborts them via the existing `POST /session/:id/abort` endpoint.
2. **Proxy circuit-breaker** — wraps the proxy to OpenCode so that after N consecutive timeouts on the message path, subsequent requests fail fast (503) for a cooldown window instead of piling up more 30 s holds.

Both pieces expose their state through the existing `/kortix/health` endpoint (extended, backward-compatible).

## Non-goals (explicit)

- Not rewriting the session model.
- Not replacing OpenCode's own abort/cancel logic.
- Not adding a new service manager — reuse `serviceManager.requestRecovery` that already exists.
- Not adding a new public route — extend `/kortix/health` response so all existing clients (mobile + web) pick it up via their existing poll.

## Existing code we reuse (already in repo, 2026-04-21)

- <ref_snippet file="/home/ubuntu/garza-suna/core/kortix-master/src/services/runtime-reload.ts" lines="30-93" /> — `getBusySessionIds()` helper + `POST /session/:id/abort` pattern. **Reuse both.**
- <ref_snippet file="/home/ubuntu/garza-suna/core/kortix-master/src/services/proxy.ts" lines="1-35" /> — `note()` deduped logger, `isOpenCodeHealthy()`, `recover()`. **Reuse.**
- <ref_snippet file="/home/ubuntu/garza-suna/core/kortix-master/src/services/proxy.ts" lines="135-197" /> — existing recovery path on timeout/ECONNREFUSED. **Extend with circuit-breaker counter.**
- <ref_snippet file="/home/ubuntu/garza-suna/core/kortix-master/src/index.ts" lines="228-260" /> — `checkOpenCodeReady()` + 5 s polled health loop. **Hook killer in as a sibling periodic task.**
- <ref_snippet file="/home/ubuntu/garza-suna/core/kortix-master/src/index.ts" lines="298-331" /> — `/kortix/health` route + `HealthResponse` schema. **Extend schema.**
- <ref_snippet file="/home/ubuntu/garza-suna/apps/mobile/lib/platform/client.ts" lines="324-336" /> — mobile client already hits `/kortix/health` and reads `.version`. **No breaking change — add optional fields.**

## Public API — extended `/kortix/health` response

Before (current shape, 2026-04-21):

```json
{
  "status": "ok",          // 'ok' | 'starting'
  "version": "0.8.44",
  "imageVersion": "0.8.44",
  "activeWs": 2,
  "runtimeReady": true
}
```

After (new optional fields at the end — all existing consumers keep working):

```json
{
  "status": "ok",
  "version": "0.8.44",
  "imageVersion": "0.8.44",
  "activeWs": 2,
  "runtimeReady": true,
  "recovery": {
    "busySessions": 2,
    "recentlyKilledSessions": 0,
    "lastKillAt": null,                  // ISO-8601 or null
    "circuitOpen": false,
    "circuitOpenUntil": null,            // ISO-8601 or null
    "consecutiveTimeouts": 0
  }
}
```

Rules:
- `recovery` is **always present** when `runtimeReady=true`; absent when `status='starting'`.
- `circuitOpen=true` → mobile + web render "Recovering" UI instead of "Unreachable".
- `recentlyKilledSessions` is a rolling 5 min counter (so the UI can say "cleaned up 3 stuck sessions").

## Config (new env vars, all with safe defaults)

| Var | Default | Meaning |
|-----|---------|---------|
| `KORTIX_STUCK_SESSION_IDLE_MS` | `90000` | A `busy` session with no message activity for this long is considered stuck. |
| `KORTIX_STUCK_SESSION_SWEEP_MS` | `30000` | How often the killer sweeps. |
| `KORTIX_STUCK_SESSION_KILL_ENABLED` | `true` | Master kill switch (rollback to disabled in seconds). |
| `KORTIX_PROXY_CB_THRESHOLD` | `3` | Consecutive timeouts to trip the breaker. |
| `KORTIX_PROXY_CB_COOLDOWN_MS` | `10000` | How long the breaker stays open. |

Read in `core/kortix-master/src/config.ts` alongside existing `OPENCODE_HOST` / `OPENCODE_PORT`.

## Files created / changed

| File | Change | Rough LoC |
|------|--------|-----------|
| `core/kortix-master/src/services/stuck-session-killer.ts` | **new** — periodic sweeper | ~110 |
| `core/kortix-master/src/services/circuit-breaker.ts` | **new** — tiny state machine (open/closed/half-open) | ~60 |
| `core/kortix-master/src/services/proxy.ts` | +CB check pre-fetch, +CB notify on timeout | ~20 diff |
| `core/kortix-master/src/index.ts` | +start killer on boot, +extended health response | ~30 diff |
| `core/kortix-master/src/schemas/health.ts` _(or wherever `HealthResponse` lives — grep & edit)_ | +`recovery` optional block | ~15 diff |
| `core/kortix-master/src/config.ts` | +5 env reads | ~15 diff |
| `core/kortix-master/tests/unit/stuck-session-killer.test.ts` | **new** — TDD first | ~150 |
| `core/kortix-master/tests/unit/circuit-breaker.test.ts` | **new** — TDD first | ~80 |
| `core/kortix-master/tests/unit/proxy-circuit.test.ts` | **new** — proxy-side integration | ~80 |

No mobile or web files in this sub-phase — those land in **B-mobile-spec.md** and B-web (future doc).

## Task breakdown (plans-for-junior-engineers style)

Each task has: goal, files, verification, commit message. Every task is 2–5 min of work.

### Task 1. Add config keys + schema fields

- **Goal:** Extend config + `HealthResponse` schema so the rest of the code can read `config.STUCK_*` and clients can receive `recovery`.
- **Files:**
  - `core/kortix-master/src/config.ts` — add 5 new env reads with defaults listed above.
  - Find `HealthResponse` schema file with `grep -r "HealthResponse" core/kortix-master/src/schemas/` and extend it with an optional `recovery` object matching the Public API section.
- **Verification:** `bun run typecheck` clean, `bun test unit/health` still passes.
- **Commit:** `feat(kortix-master): add stuck-session killer + circuit-breaker config keys`

### Task 2. Circuit-breaker (TDD — red)

- **Goal:** Failing tests for a tiny circuit-breaker state machine.
- **Files:** `core/kortix-master/tests/unit/circuit-breaker.test.ts`
- **Tests to write:**
  - Closed state: records 1 timeout → stays closed
  - Closed state: `threshold` consecutive timeouts → trips to open
  - Open state: `isOpen()` returns true until `cooldownMs` elapses
  - Open state: a success does NOT close it until cooldown elapses (no premature close)
  - Half-open (post-cooldown): next failure re-opens immediately; next success fully closes
  - `recordTimeout()` resets consecutive count on success
- **Verification:** `bun test unit/circuit-breaker` → **red** (file under test doesn't exist yet).
- **Commit:** `test(kortix-master): circuit-breaker red tests`

### Task 3. Circuit-breaker (green)

- **Goal:** Implement `CircuitBreaker` to satisfy tests.
- **File:** `core/kortix-master/src/services/circuit-breaker.ts`
- **API:**
  ```ts
  export interface CircuitBreakerState {
    open: boolean;
    openUntilMs: number | null;
    consecutiveFailures: number;
  }
  export class CircuitBreaker {
    constructor(opts: { threshold: number; cooldownMs: number; now?: () => number });
    recordTimeout(): void;
    recordSuccess(): void;
    isOpen(): boolean;
    state(): CircuitBreakerState;
  }
  ```
- **Verification:** `bun test unit/circuit-breaker` → **green**.
- **Commit:** `feat(kortix-master): CircuitBreaker class`

### Task 4. Wire breaker into proxy

- **Goal:** Proxy checks breaker before fetching upstream; records timeout on 504; records success on 2xx/3xx/4xx that isn't 5xx.
- **File:** `core/kortix-master/src/services/proxy.ts` — module-level singleton `messageBreaker` instantiated from config.
- **Behavior:**
  - If `messageBreaker.isOpen()` and path matches `/session/*/message`, return `503 { error: 'recovering', retryAfterMs }` immediately (fast-fail).
  - On catch-block `AbortError`/`TimeoutError` for `/session/*/message`: `messageBreaker.recordTimeout()`.
  - On successful 2xx/3xx response for the same path: `messageBreaker.recordSuccess()`.
- **Tests:** `core/kortix-master/tests/unit/proxy-circuit.test.ts` using existing `opencode-proxy.test.ts` fixtures (mock `fetch`).
  - Assertion 1: 3 timeouts → 4th request fast-fails 503 without calling upstream.
  - Assertion 2: After cooldown, request flows again.
  - Assertion 3: Non-`/session/*/message` paths unaffected.
- **Verification:** `bun test unit/proxy-circuit` green; `bun test unit/opencode-proxy` still green.
- **Commit:** `feat(kortix-master): wire circuit-breaker into OpenCode proxy`

### Task 5. Stuck-session killer (TDD — red)

- **Goal:** Failing tests for sweeper.
- **File:** `core/kortix-master/tests/unit/stuck-session-killer.test.ts`
- **Tests to write:**
  - With injected `fetch` mock returning `{ "sess-A": { type: "busy" }, "sess-B": { type: "idle" } }`:
    - After `sweep()`, issues POST `/session/sess-A/abort` — NOT sess-B.
  - Session stays `busy` for < `idleMs` → NOT aborted (killer tracks first-seen-busy timestamp per session).
  - Session transitions busy→idle→busy — timer resets.
  - `KORTIX_STUCK_SESSION_KILL_ENABLED=false` → sweep is no-op (still reads status, updates metrics, but doesn't POST abort).
  - `getMetrics()` returns `{ busySessions, recentlyKilledSessions, lastKillAt }` with correct values across sweeps.
  - 5 min rolling window: kill at t=0 → `recentlyKilledSessions=1`; at t=5:01 → `recentlyKilledSessions=0`.
- **Verification:** `bun test unit/stuck-session-killer` → **red**.
- **Commit:** `test(kortix-master): stuck-session-killer red tests`

### Task 6. Stuck-session killer (green)

- **Goal:** Implement sweeper to satisfy tests.
- **File:** `core/kortix-master/src/services/stuck-session-killer.ts`
- **API:**
  ```ts
  export interface KillerMetrics {
    busySessions: number;
    recentlyKilledSessions: number;  // rolling 5 min
    lastKillAt: string | null;       // ISO-8601
  }
  export class StuckSessionKiller {
    constructor(opts: {
      baseUrl: string;
      idleMs: number;
      sweepMs: number;
      enabled: boolean;
      fetch?: typeof globalThis.fetch;
      now?: () => number;
    });
    start(): void;
    stop(): void;
    sweep(): Promise<void>;       // exposed for tests
    getMetrics(): KillerMetrics;
  }
  ```
- **Uses existing `getBusySessionIds()` from runtime-reload.ts.** Do NOT copy-paste — import it.
- **Verification:** `bun test unit/stuck-session-killer` → green.
- **Commit:** `feat(kortix-master): StuckSessionKiller service`

### Task 7. Wire killer + extended health into index.ts

- **Goal:** Boot killer alongside `checkOpenCodeReady`; surface state in `/kortix/health`.
- **File:** `core/kortix-master/src/index.ts`
- **Changes:**
  - Create singleton `killer = new StuckSessionKiller({…config…})`; call `killer.start()` after service-manager boot.
  - In `/kortix/health` handler, when `runtimeReady=true`, assemble `recovery` from `killer.getMetrics()` + `messageBreaker.state()` and include in response.
- **Verification:** `curl http://localhost:13738/kortix/health | jq .recovery` shows the new block on a dev instance. `bun test integration/health` (add one) asserts shape.
- **Commit:** `feat(kortix-master): surface stuck-session killer + circuit-breaker state on /kortix/health`

### Task 8. Smoke on `super.garzaos.online` (partner-approved)

**Requires explicit partner approval per session rule.** Deploy via normal Kortix update mechanism. Verify with:

```bash
ssh ubuntu@83.228.213.100 'curl -s http://127.0.0.1:13738/kortix/health | jq .recovery'
# expected: {"busySessions":0,"recentlyKilledSessions":0,"lastKillAt":null,"circuitOpen":false,"circuitOpenUntil":null,"consecutiveTimeouts":0}

# force a stuck-session scenario in a test account, observe:
docker logs kortix-hosted-sandbox --since 5m | grep stuck-session-killer
```

Acceptance: a deliberately-stuck session is aborted within `idleMs + sweepMs` (≤ 2 min default).

## Rollback

- All behavior gated on env flags. `KORTIX_STUCK_SESSION_KILL_ENABLED=false` + `KORTIX_PROXY_CB_THRESHOLD=999999` → back to current behavior with zero code revert. Apply via normal `.env` edit + kortix-master restart (no container rebuild).

## TDD discipline (red → green → refactor)

- Tasks 2, 3 = one RED + one GREEN for circuit-breaker.
- Tasks 5, 6 = one RED + one GREEN for killer.
- Task 4 = RED (mock fetch) + GREEN (wiring) in one commit pair if smaller, otherwise split.
- No implementation file is committed before its test file.

## Risk assessment

| Risk | Mitigation |
|------|------------|
| Killer aborts a session the user actually wants to wait out | 90 s default idle threshold + env-tunable; `KORTIX_STUCK_SESSION_KILL_ENABLED=false` rollback in seconds |
| Circuit-breaker false-positive hides a real upstream problem | `recovery.circuitOpen` + `consecutiveTimeouts` visible on `/kortix/health` — operators can see it tripped |
| Abort endpoint itself hangs | Killer wraps each abort in `AbortSignal.timeout(5_000)` (same as `runtime-reload.ts`); sweep continues to next session |
| New tests flake in CI | Tests use injected `now()` + injected `fetch` mock — no real timers, no network |

## Open questions for partner before implementation

1. **Idle threshold of 90 s** is an audit-derived guess. Seen sessions that legitimately need > 90 s of quiet think time? If yes, raise default to 180 s.
2. **Circuit-breaker only on `/session/:id/message`** — everything else (file ops, status reads) keeps today's behavior. Is that the right scope, or widen to any `/session/*` POST?
3. **Deploy target.** Should implementation PRs land in `itsablabla/garza-suna` only, or also be mirrored back to an upstream `kortix-ai/suna` fork / PR? (Today's audit branch is `devin/1776799911-kortix-audit-fixes` on the `itsablabla` fork.)

## Dependencies

- **B.mobile** (separate spec, next) consumes the new `recovery` block read-only — no breaking changes, OTA-deployable to the mobile app via Expo Updates (per Suna mobile writeup).
- **B.web** (separate, future) does the same for web frontend.
- **B.connectors** (separate) does the Pipedream binding fix — independent from this spec.
- **B.stripe** (separate, tiny) — flag gate on `resolve-account.ts`. Can ship standalone.

---

_Approval checklist for partner:_

- [ ] Approve the extended `/kortix/health` response shape (backward-compatible)
- [ ] Approve default threshold values (idle 90 s, sweep 30 s, breaker 3 × 10 s)
- [ ] Approve the three open questions above
- [ ] Approve scope (one PR for this sub-phase, B-mobile next, do NOT bundle)
