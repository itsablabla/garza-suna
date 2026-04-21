# Task plan — Kortix audit fixes (super.garzaos.online)

**Branch:** `devin/1776799911-kortix-audit-fixes`
**Started:** 2026-04-21
**Methodology:** Superpowers (brainstorm-before-build → planning-with-files → plans-for-junior-engineers → verify-before-complete)
**Source of truth for findings:** [`audit-report.md`](./audit-report.md)

## Goal

Fix or mitigate the two live symptoms observed on `super.garzaos.online`:
1. Intermittent disconnects / `Unreachable Xs` badge in dashboard
2. Agent reports "no access to connectors" despite Pipedream integration records existing

And take low-risk opportunities to harden the host per the audit's P2/P3 recommendations.

## Non-goals (this pass)

- Upstream contribution to `kortix-ai/kortix`
- Billing/credits implementation
- SMTP setup
- Signup policy changes
- Log aggregation / observability stack

## Phases

### Phase A — sandbox quick-fix (operational) — DEFERRED
- [~] Pre-restart probe showed symptom has already self-cleared (busy=0, health=200, CPU 4.2%). Restart would be preventive, not corrective.
- [~] Re-open the moment `Unreachable` badge re-appears or `busy` count > 2 for > 2 min.
- See `progress.md` entry A.2 for rationale.

### Phase C — host hardening (reliability subset applied, security subset deferred)
- [x] **C3** — 4 GB swap file at `/swapfile` + fstab. `free -h` shows 4.0 Gi swap. Zero lockout risk.
- [x] **C2** — `/etc/docker/daemon.json` with log rotation + `live-restore: true`. `docker info` shows `Live Restore Enabled: true`; `systemctl reload docker` did not restart containers.
- [x] **C5** — Archived orphan `.api-dev.env` / `.frontend-dev.env` under `~/.kortix/archive/`. `docker compose config` parses clean; all 3 containers still Up.
- [~] **C1** — Caddy security headers: **deferred** (security-focused, partner prioritizing reliability/speed).
- [~] **C4** — `fail2ban`: **deferred** (security-focused + SSH lockout risk).

### Phase E — onboarding (UI, requires test mode)
- [ ] Complete in-UI setup wizard as `jadengarza@pm.me`
- [ ] Grant platform admin role to jadengarza@pm.me
- [ ] Seed credit rows

### Phase B — source fixes (separate worktree, TDD, detailed spec first)

**Scope across all client surfaces** — the reaper is not just a core-kortix-master concern; it must surface cleanly in the mobile app too (per partner direction 2026-04-21).

- [ ] **B.core** — Session reaper / circuit-breaker in `core/kortix-master/src/`
  - Detect stuck `busy` sessions (threshold: idle > 60 s while `busy=true`)
  - Force-abort offending sessions; emit event
  - Circuit-breaker around `/session/:id/message`: if 3 consecutive 30 s timeouts, stop hitting OpenCode for N seconds
  - Expose reaper state at `/kortix/reaper/status` (count of reaps, last reap time, open-circuit flag)
- [ ] **B.api** — `apps/api/` surfaces reaper state in instance health so clients can render it
- [ ] **B.web** — `apps/web/` + `apps/frontend/` sidebar status: replace "Unreachable Xs" badge with structured reaper state (e.g. "Recovering Xs — N stuck sessions cleared")
- [ ] **B.mobile** — `apps/mobile/lib/platform/` + `lib/opencode/sync-store.ts` consumes the same reaper state; UI shows a calm recovery indicator instead of silent disconnect
- [ ] **B.connectors** — Bind account-scoped Pipedream integrations into sandbox OpenCode plugin registry at session start (separate commit, in core)
- [ ] **B.stripe** — Gate `[resolve-account] Stripe sync error` on billing flag (small; drops out of B.core work)

**Delivery plan:** one PR per sub-phase (B.core first, then B.api+B.web+B.mobile together as the UI integration, then B.connectors, then B.stripe). TDD where the reaper logic has observable state transitions.

## Decisions log

| When | Decision | Rationale |
|------|----------|-----------|
| 2026-04-21 | Put planning files in `docs/audit-2026-04-21/` instead of repo root | Matches existing `docs/*-spec.md` convention; avoids root pollution |
| 2026-04-21 | CSP in Report-Only first | Real CSP without observation will break Next.js dev scripts |
| 2026-04-21 | Archive orphan .env files, don't delete | Reversible; they might still be used by a dev-mode workflow |
| 2026-04-21 | Phase B gets its own spec doc + worktree | Source changes need TDD; mixing with host hardening would bundle unrelated changes |

## Errors encountered

_(none yet)_

## Current status

- [x] Setup complete
- [ ] Phase A in progress
