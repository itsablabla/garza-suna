# Findings — Kortix audit evidence (super.garzaos.online)

Captured during the read-only audit on 2026-04-21. Full audit report in [`audit-report.md`](./audit-report.md).

## Environment snapshot (at audit time)

| Item | Value |
|------|-------|
| Domain | `super.garzaos.online` → 83.228.213.100 |
| Install path | `/home/ubuntu/.kortix/` |
| Version | 0.8.44 (api, frontend, sandbox) |
| Mode | VPS + external Supabase cloud |
| Supabase project | `kortix-prod` (`xwwkjguyihysjqvdwjau`, us-east-1) |
| Auth site_url | `https://super.garzaos.online` (correct) |
| Host OS | Ubuntu 24.04.3 LTS, kernel 6.8.0-71 |
| Host capacity | 6 vCPU, 17.5 GB RAM, **0 swap** |
| Docker | 29.4.1 |
| Uptime at audit | 1 h 41 min |

## Symptom #1 — disconnects / `Unreachable Xs` badge

**Evidence:**
- UI screenshot confirmed `Unreachable 13s` badge in dashboard (user-provided)
- API logs:
  ```
  [2026-04-21T19:12:04.433Z] [WARN] Slow/error request: GET /v1/p/kortix-hosted-sandbox/8000/session/ses_24e9bde45ffeZMC9bVbIZBTRd9/message 500 30811ms
  [Kortix Master] OpenCode is no longer reachable
  --> GET /kortix/health 503 3s
  [Kortix Master] OpenCode timeout on GET /session/.../message after 30s
  ```
- Caddy error logs: `reverseproxy.statusError` 502, EOF, ~9 s duration
- At one probe: **7 sessions pinned `busy`**, sandbox at ~200% CPU / 5.8 GB / 1400 PIDs
- 5 min later: busy count 0, `/kortix/health` 200 → self-clearing
- Sandbox `RestartCount=0` → not crashing, wedging on stuck sessions

**Root cause:** OpenCode serializes on busy sessions; without a session reaper they accumulate until new requests start timing out.

## Symptom #2 — no access to connectors

**Evidence:**
- Agent's own UI message: "connected plugins appear to be in a different scope/session than this local sandbox"
- Supabase `user_integrations` table has 2 rows (Notion + GitHub via Pipedream, created 2026-04-21)
- Sandbox `/workspace/.opencode/opencode.jsonc` is essentially empty:
  ```json
  {
      "$schema": "https://opencode.ai/config.json"
  }
  ```
- `/config/status` inside sandbox returns `valid: true`, `problems: []` — so the plugin registry is well-formed but has **no entries** for the Pipedream-bound integrations
- Pipedream API reachable from the sandbox (network OK)

**Root cause:** The binding step between account-level integrations (Supabase `user_integrations`) and the sandbox-local OpenCode plugin registry is not running at session start — or not running for this particular sandbox.

## Silent issues observed

### Stripe sync error loop

API container log, ~40×/minute:
```
[resolve-account] Stripe sync error ... basejump.billing_customers
```
- Billing is disabled (`KORTIX_BILLING_INTERNAL_ENABLED=false`) but the resolver fires anyway
- `basejump.billing_customers` is empty

### Incomplete onboarding

- `accounts.setup_complete_at = null`
- `accounts.setup_wizard_step = 0`
- `kortix.platform_user_roles` table empty → `/admin` will 403
- No `credit_accounts`, `credit_ledger`, `billing_customers` rows

### Orphan dev-mode env files

- `/home/ubuntu/.kortix/.api-dev.env` references `SUPABASE_URL=http://83.228.213.100:13740` (non-existent local Supabase)
- `/home/ubuntu/.kortix/.frontend-dev.env` references `NEXT_PUBLIC_SUPABASE_URL=http://localhost:13740`
- Not read by current VPS-mode compose but confusing on inspection

### Caddy minimal config

`/etc/caddy/Caddyfile` is 161 bytes, has:
- gzip/zstd encoding
- reverse proxy to :13737 (frontend), :13738 (api)

Missing: HSTS, CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, access log, per-path timeouts, rate limit.

### Host-level

- 0 swap on 17.5 GB RAM host
- No `fail2ban`
- No Docker log rotation / `live-restore: true` → container logs grow unbounded, daemon restarts kill running containers

## External reachability (from sandbox)

- Pipedream API: reachable
- OpenRouter API: reachable (key present in .env)
- Supabase REST / Auth: reachable
- DNS: resolving via systemd-resolved

Network is not the issue for connectors; the binding layer is.
