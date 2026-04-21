# Progress log — Kortix audit fixes

Session log, chronological. Each entry includes the command(s) run, expected result, and actual result (per `verify-before-complete`).

## 2026-04-21 — Setup

### Setup.1 — Create branch + planning files

- Branch: `devin/1776799911-kortix-audit-fixes` (off `main`)
- Dir: `docs/audit-2026-04-21/` created
- Files written: `task_plan.md`, `findings.md`, `progress.md`, `audit-report.md` (copy of original)
- Verify: `git status` clean before commit; `ls docs/audit-2026-04-21/` shows 4 files

Status: done.

---

## 2026-04-21 — Phase A (sandbox quick-fix)

### A.1 — Pre-restart baseline probe (2026-04-21 19:33 UTC)

Ran from my VM, SSH as `ubuntu@83.228.213.100`:

```
docker ps:
  kortix-hosted-sandbox   Up About an hour   running
  kortix-frontend-1       Up 2 hours         running
  kortix-kortix-api-1     Up 2 hours         running

docker stats kortix-hosted-sandbox (no stream):
  CPU %    MEM USAGE          PIDS
  4.21%    3.601 GiB / 17.56  1406

docker exec kortix-hosted-sandbox curl -sS http://127.0.0.1:8000/kortix/health:
  http=200  time=0.003705s

docker exec kortix-hosted-sandbox curl -sS http://127.0.0.1:4096/session:
  total sessions: 7
  busy: 0

kortix-master (bun, PID 638): 5.6% CPU, 160 MB RSS
```

### A.2 — Decision: defer restart

**The symptom has already self-cleared.** `/kortix/health` returns 200 in 3.7 ms, busy sessions = 0, CPU has dropped from the peak ~200% observed during the audit to a quiet 4.2%. PIDs are still 1406 (elevated for an idle sandbox — Chromium + X + s6 trees), but that's a cold baseline, not a wedge indicator.

A restart right now would be preventive, not corrective. Applying `verify-before-complete`: the verification command for "fix the symptom" returns *already green*, so there's nothing to fix in this moment. The **root cause** (no session reaper) is still present and will re-wedge sooner or later — that's Phase B's problem.

**Action:** skip A (no restart). Marking as N/A with rationale. The restart is a 15-second operation we can invoke the instant the symptom re-appears.

Status: **deferred (unneeded at this moment)**. Re-open if `Unreachable` badge returns before Phase B ships.

---

## 2026-04-21 — Phase C (host hardening, reliability subset)

Per partner direction: reliability/speed focus, no lockout-risk changes. Deferred C1 (Caddy headers, security) and C4 (fail2ban, security + lockout risk).

### C.3 — 4 GB swap file — DONE

Ran `C3-swap.sh` on `ubuntu@83.228.213.100`.

```
Setting up swapspace version 1, size = 4 GiB (4294963200 bytes)
UUID=3231d712-0910-408e-a1d2-eb6fb408ab87
/swapfile none swap sw 0 0
--- verification ---
               total        used        free      shared  buff/cache   available
Mem:            17Gi       4.2Gi       7.8Gi       517Mi       6.5Gi        13Gi
Swap:          4.0Gi          0B       4.0Gi
/swapfile none swap sw 0 0
```

Before: 0 B swap. After: 4 GB swap, 0 B used (expected — no memory pressure), fstab persisted.
Status: **done + verified.** Containers still Up.

### C.2 — /etc/docker/daemon.json — DONE

```
--- pre-state ---
Logging Driver: json-file
Live Restore Enabled: false

--- post-state ---
Logging Driver: json-file
Live Restore Enabled: true

--- effective daemon.json ---
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "50m", "max-file": "3" },
  "live-restore": true
}
```

`systemctl reload docker` did not restart any container — all three stayed Up (sandbox: Up About an hour, api: Up 2 hours, frontend: Up 2 hours). `live-restore: true` is now live; on next docker daemon restart event containers will continue running. Log rotation (`max-size: 50m`, `max-file: 3`) applies to new containers; existing container logs keep their current driver settings.
Status: **done + verified.**

### C.5 — Archive orphan dev .env files — DONE

```
archived: .api-dev.env
archived: .frontend-dev.env
--- verification ---
docker compose config: OK
NAMES                   STATUS
kortix-hosted-sandbox   Up About an hour
kortix-frontend-1       Up 2 hours
kortix-kortix-api-1     Up 2 hours
```

Moved to `~/.kortix/archive/` with UTC timestamp suffix; reversible by `mv` back. `docker compose config` parses clean — files were indeed not referenced.
Status: **done + verified.**

### C.1 / C.4 — Deferred

- C.1 (Caddy security headers) — security-focused, not reliability/speed. Re-open when security hardening becomes priority.
- C.4 (fail2ban) — security-focused + SSH lockout risk. Re-open only with a known-good whitelist strategy.

---

## 2026-04-21 20:00 UTC — LIVE 502 INCIDENT + PR1 B.stripe open

### Incident snapshot

- **User-visible symptom:** 502 popup on dashboard at ~19:49 UTC
- **Scope:** self-cleared by 19:52, no container restarts, no OOMs, all 3 containers Up 2h
- **Caddy edge:** 157 `status:502 msg:"unexpected EOF"` on path `/v1/p/kortix-hosted-sandbox/8000/project/current` in the 10-min window; peak 127/min at 19:49
- **kortix-api:** 866 `[resolve-account] Stripe sync error` log lines in same window (~87/min) — one per account resolution under dashboard poll load
- **Root cause (confirmed):** `apps/api/src/shared/resolve-account.ts:22,53` calls `syncLegacySubscription()` unconditionally even though the container has `KORTIX_BILLING_INTERNAL_ENABLED=false`. Every poll triggers a failed DB query against the non-existent `basejump.billing_customers` table. Under concurrent dashboard polling the failed-query work saturates kortix-api's event loop and surfaces at the edge as upstream 502/EOFs.

### PR1 — B.stripe (billing-gate)

- **Branch:** `devin/1776801000-b-stripe-billing-gate` (separate from docs branch for independent revert)
- **PR URL:** https://github.com/itsablabla/garza-suna/pull/1
- **Diff:** +62 / -0 across `apps/api/src/shared/resolve-account.ts` (+8) and `apps/api/src/__tests__/unit-resolve-account.test.ts` (+54)
- **Fix:** early-return from `syncLegacySubscription()` when `config.KORTIX_BILLING_INTERNAL_ENABLED === false`. Aligns with every other billing entry point in `apps/api/src/billing/*`.
- **TDD:** red first (2 new tests failed against unmodified code) → green (all 4 tests pass after guard).
- **Local verification:**
  ```
  bun test src/__tests__/unit-resolve-account.test.ts
  → 4 pass / 0 fail / 19 expect() calls
  ```
- **CI:**
  - Devin Review: "No Issues Found"
  - Kilo Code Review: status "failed" (advisory AI review bot, not a test runner; logs not fetchable from agent tools — see PR comments for Kilo's output)
  - Pre-existing typecheck errors on `main` (in credits.test.ts, webhooks.test.ts, e2e-preview-proxy.test.ts, e2e-sandbox-update-status.test.ts, etc.) are unchanged by this PR.
- **Expected post-deploy verification on super.garzaos.online:**
  ```
  docker logs --since 5m kortix-api 2>&1 | grep -c 'resolve-account.*Stripe sync error'
  → 0   (was ~435/5min)
  ```
- **Rollback:** `git revert de1300017ca65160061328e98f5426b8f29dab43` — zero schema/config changes, zero new env vars.

Status: **PR open, awaiting partner review; merge + deploy pending approval.**

---

## 2026-04-21 20:05 UTC — B.connectors initial investigation

Started in parallel with PR1 review. Goal: understand the sandbox-side MCP server binding so I can scope PR2.

### What I found

The Pipedream integration pipeline already wires account-side → sandbox-side, **but stops one hop short of OpenCode's MCP registry**:

1. **Web/mobile UI → API** (`apps/api/src/integrations/routes.ts`):
   - OAuth connect flow writes to Supabase `user_integrations` + `sandbox_integrations` link table
   - `notifySandboxesConnectorSync()` POSTs to `${sandbox.baseUrl}/api/pipedream/connector-sync` for each linked sandbox

2. **Sandbox handler** (`core/kortix-master/src/routes/pipedream.ts:566-600`):
   - Receives `{ app, app_name }`
   - Writes a row to SQLite at `/workspace/.kortix/kortix.db` → `connectors` table
   - Does **NOT** write to `/workspace/.opencode/opencode.jsonc` `mcp.servers` section

3. **OpenCode's `opencode.jsonc`** (`core/kortix-master/opencode/opencode.jsonc`):
   - Base template has no `mcp` block at all
   - No code path in core that binds the SQLite `connectors` table → `mcp.servers` in opencode.jsonc at session start

### The gap (Root Cause #2 — B.connectors scope)

When a session starts, OpenCode reads `/workspace/.opencode/opencode.jsonc` and loads whatever MCP servers are declared there. But:
- Account-level Pipedream connectors live in Supabase and the sandbox's SQLite DB
- Neither of those is ever materialized into `opencode.jsonc`'s `mcp.servers` object

Result: what the user sees in the "MCP Servers" list depends on ephemeral in-memory registration (which can churn during recovery events), not the durable config. Hence the "2 servers, then 1 server, then 0" fluctuation in the screenshots.

### Proposed shape of the fix (not yet implemented)

A new idempotent step in the sandbox session-init sequence:

1. Read all rows from `/workspace/.kortix/kortix.db` → `connectors` where `source='pipedream'`
2. Synthesize an MCP server entry per row (local-stdio MCP talking to the `kpipedream` CLI with the right `--app` flag)
3. Merge into `/workspace/.opencode/opencode.jsonc` under `mcp.servers` — preserve any user-authored entries, overwrite only auto-generated ones
4. Trigger OpenCode config reload via existing `/instance/dispose` (hot reload, ~2s, already documented in runtime-reload.ts)

This means:
- No new API/network calls
- No schema changes
- One new module in `core/kortix-master/src/services/` (e.g., `mcp-registry-bind.ts`)
- Gated on an env flag so rollback = flag off + restart kortix-master

Full spec to follow as `docs/audit-2026-04-21/B-connectors-spec.md` before writing test code — same pattern as B-core-reaper-spec.md. Not proceeding to code until partner reviews the spec.

Status: **investigation complete; spec pending; no code written.**


