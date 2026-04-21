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

### Phase C — host hardening (5 commits, each reversible)
- [ ] **C1** — Caddy security headers block (HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, CSP in Report-Only)
  - Verify: `curl -sI https://super.garzaos.online/` shows new headers; `curl -sI` follow-up through main app path still returns 2xx/3xx
- [ ] **C2** — `/etc/docker/daemon.json` with `log-opts: {max-size: "50m", max-file: "3"}`, `live-restore: true`
  - Verify: `docker info` shows new logging driver opts; `systemctl reload docker` returns clean; all 3 containers still Up afterward
- [ ] **C3** — 4 GB swap file at `/swapfile`, `swapon`, fstab entry
  - Verify: `free -h` shows 4 GB swap, `cat /proc/sys/vm/swappiness` (leave default 60); `grep swap /etc/fstab` shows entry
- [ ] **C4** — `fail2ban` package + `sshd` jail
  - Verify: `systemctl is-active fail2ban` → `active`; `fail2ban-client status sshd` shows jail loaded
- [ ] **C5** — Archive orphan `.api-dev.env` and `.frontend-dev.env` under `~/.kortix/archive/`
  - Verify: files moved (not deleted); `docker compose config` still parses (no references to them); three containers still Up

### Phase E — onboarding (UI, requires test mode)
- [ ] Complete in-UI setup wizard as `jadengarza@pm.me`
- [ ] Grant platform admin role to jadengarza@pm.me
- [ ] Seed credit rows

### Phase B — source fixes (separate worktree, TDD, detailed spec first)
- [ ] Session reaper / circuit-breaker in `kortix-master` for stuck `busy` sessions
- [ ] Bind account-scoped Pipedream integrations into sandbox OpenCode plugin registry at session start
- [ ] Gate `[resolve-account] Stripe sync error` on billing flag (falls out of this phase)

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
