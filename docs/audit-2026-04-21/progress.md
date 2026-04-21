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


