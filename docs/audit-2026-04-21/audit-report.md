# Kortix @ `super.garzaos.online` — Consolidated Audit
**Date:** 2026-04-21 · **Scope:** Read-only observation + improvement opportunities · **Auditor:** Devin (no changes made)

## 0. TL;DR

Install is healthy *at the surface* — TLS, DNS, Caddy, containers, Supabase, auth gate — but two live problems are causing the symptoms you reported:

| Symptom you saw | Root cause (evidence) |
|---|---|
| "Disconnected" / `Unreachable 13s` badge | OpenCode inside the sandbox **wedges on stuck `busy` sessions** → `/kortix/health` flaps 503, `/session/:id/message` times out at 30 s → API returns 504 → Caddy returns 502 to browser. When I probed the sandbox the first time, 7 sessions were pinned `busy` and CPU was **148–200 % (~2 cores)**. When I re-checked 5 min later, busy count was 0 and the UI recovers — consistent with the intermittent pattern you describe. |
| "No access to its connectors" | Pipedream integrations are wired **at the account scope in Supabase** (2 rows — Notion + GitHub — confirmed on your account), but the **sandbox-internal OpenCode plugin registry** on `/workspace/.opencode/` is essentially empty (`opencode.jsonc` has only `$schema`, no connector plugins configured). The agent in your screenshot reports this itself: "no `github`/`notion` connector records … connected plugins appear to be in a different scope/session than this local sandbox." This is a scope/sync gap between account-level integrations and the sandbox-local plugin wiring, not a network or auth failure (Pipedream reaches fine from the sandbox: `api.pipedream.com 200 OK in 0.40 s`). |

Everything else in this report is either confirmation of what's working or prioritized improvement opportunities.

---

## 1. Topology (as observed)

```
Browser (user)
      │  HTTPS / HTTP/2, HTTP/3 advertised
      ▼
super.garzaos.online → 83.228.213.100  (A-record; AAAA 2001:1600:18:200::3ef)
      │                                 (not Hostinger; hostname ov-d90518, likely OVH)
      ▼
Caddy 2.x  (systemd `caddy.service`, PID 9451, bound :80 + :443, admin 127.0.0.1:2019)
      │                                 Let's Encrypt E8 cert issued 2026-04-21 16:59 UTC, valid until 2026-07-20
      ├─ /v1/* ──► 127.0.0.1:13738 → kortix-kortix-api-1  (kortix/kortix-api:0.8.44)
      └─ /*     ──► 127.0.0.1:13737 → kortix-frontend-1   (kortix/kortix-frontend:0.8.44)
                                        │
                                        ▼
                              kortix-hosted-sandbox    (kortix/computer:0.8.44)
                              15000–15007 mapped 127.0.0.1-only
                              inside: s6 supervisor → kortix-master (bun, :8000)
                                                    → opencode serve :4096  ← this is what wedges
External:
  Supabase cloud  kortix-prod / xwwkjguyihysjqvdwjau.supabase.co (us-east-1, PG 17.6.1, ACTIVE_HEALTHY)
  Pipedream      api.pipedream.com, mcp.pipedream.com (both reachable host + sandbox)
  LLM            OpenRouter key in .env; no Anthropic/OpenAI in root .env
```

Host: Ubuntu 24.04.3, kernel 6.8.0-71, Docker 29.4.1, 6 vCPU / 17.5 GB RAM / 0 swap. Install dir: `/home/ubuntu/.kortix/` (not `/root/.kortix/`). `kortix` CLI wrapper present at `/home/ubuntu/.kortix/kortix` (~15 KB bash).

---

## 2. Surface-by-surface status

### 2.1 DNS + TLS — **PASS**
- `super.garzaos.online` → `83.228.213.100` / `2001:1600:18:200::3ef`
- Cert: Let's Encrypt E8, issued today, valid 90 d
- HTTP/2 + HTTP/3 alt-svc advertised

### 2.2 Caddy — **PASS (minimal config)**
`/etc/caddy/Caddyfile` (161 bytes):
```
super.garzaos.online {
    encode gzip zstd
    @api path /v1 /v1/*
    handle @api { reverse_proxy 127.0.0.1:13738 }
    handle     { reverse_proxy 127.0.0.1:13737 }
}
```
Missing (by design or oversight): HSTS, CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, access log, per-path timeouts, rate-limit. See §5.

### 2.3 UFW — **PASS**
```
22/tcp  ALLOW Anywhere
80/tcp  ALLOW Anywhere
443/tcp ALLOW Anywhere
default deny incoming, allow outgoing, deny routed
```
All 13737 / 13738 / 15000–15007 / 2019 are bound to `127.0.0.1` only ✓

### 2.4 Frontend (`:13737`, `kortix-frontend-1`) — **PASS**
- Next.js 15.5.14 ready in 126 ms
- Entrypoint rewrites `BACKEND_URL=localhost:8008` → `https://super.garzaos.online/v1` ✓
- No errors in logs
- Mem ~187 MB, CPU idle

### 2.5 API (`:13738`, `kortix-kortix-api-1`) — **PASS with noisy error**
- `/v1/health` → `200 {"status":"ok","version":"0.8.44","env":"local","tunnel":{"enabled":true,"connectedAgents":0}}`
- Mem ~379 MB, CPU ~1 %
- **Noisy error (benign but spams logs on every request):**
  ```
  [resolve-account] Stripe sync error for a99feb3f-9590-4d46-bbab-3706cc21a7f2:
  Failed query: select "account_id","id","email","active","provider"
                from "basejump"."billing_customers"
                where "basejump"."billing_customers"."account_id" = $1
  ```
  → The Stripe sync path runs unconditionally even though `KORTIX_PUBLIC_BILLING_ENABLED=false` and no `basejump.billing_customers` row exists for this account. 40+ occurrences in the last minute. Cosmetic, but clutters logs and wastes DB roundtrips.

### 2.6 Sandbox (`kortix-hosted-sandbox`) — **DEGRADED (intermittent)**

`com.docker.compose.service=kortix-api` labels confirm single-project name `kortix`. Sandbox image `kortix/computer:0.8.44`, uptime ~57 min at probe, **RestartCount=0**.

**s6 service tree (all up):**
```
svc-kortix-master        up   3501 s   (bun /ephemeral/kortix-master/src/index.ts on :8000)
svc-opencode-serve       up   3501 s   ← s6 placeholder, actual process owned by kortix-master
svc-opencode-state-sync  up   3501 s
svc-nginx svc-chromium-persistent svc-agent-browser-session svc-selkies  (all up)
```

**Actual OpenCode process (spawned by kortix-master, not by s6 directly):**
```
PID 35541  opencode-kortix serve --port 4096 --hostname 0.0.0.0
  CPU 50.9 %, RSS 835 MB  (started 18:42)
```

**The smoking gun — `docker logs kortix-hosted-sandbox` excerpt:**
```
[Kortix Master] OpenCode is no longer reachable
--> GET /kortix/health 503 3s
[Kortix Master] OpenCode timeout on GET /session/ses_24e9bde45ffe.../message after 30s
--> GET /session/ses_24e9bde45ffe.../message 504 32s
```
Correspondingly on the API side:
```
[ERROR] GET /v1/p/kortix-hosted-sandbox/8000/session/ses_.../message -> 500 [DOMException] aborted
[WARN]  Slow/error request … 500 30811 ms
```
And Caddy throws 502 EOF when the upstream aborts:
```
caddy http.log.error msg="EOF" … status 502 err_trace=reverseproxy.statusError
```

**At peak I observed:**
- `docker stats kortix-hosted-sandbox`: **199.73 % CPU, 5.83 GiB / 17.6 GiB, 1400 PIDs**
- 7 sessions pinned `{"type":"busy"}` simultaneously (`ses_24ea8073…`, `ses_24ea47ec…`, `ses_24e9bde45…`, `ses_24e9d7e09…`, `ses_24e9f5710…`, `ses_24ea45ab6…`, `ses_24e9a012a…`)

**A few minutes later the same sandbox returned to:**
- 0 busy sessions, CPU falling back, `/kortix/health 200 runtimeReady:true` — i.e. the symptom is transient and self-clearing but repeats.

**What's NOT the cause (ruled out):**
- OpenCode config is valid: `/config/status` → `{"valid":true,"loadedSources":[".../workspace/.opencode/opencode.jsonc",".../ephemeral/kortix-master/opencode/opencode.jsonc"],"problems":[]}`
- OpenCode has providers: `auth.json` contains `openrouter` + `openai` credential blocks
- Network from sandbox is fine: `api.pipedream.com 200 @ 0.40 s`, `supabase.co 404 @ 0.07 s` (404 on bare root is normal)
- Restart count 0, s6 services all up

### 2.7 Supabase — **PASS**
- Project `kortix-prod` (`xwwkjguyihysjqvdwjau`), us-east-1, PG 17.6.1, ACTIVE_HEALTHY, created today 12:27 UTC
- Schemas present: `public`, `auth`, `kortix`, `basejump`, `storage`, `vault`, `graphql`, `realtime`
- Extensions: `pg_graphql 1.5.11`, `pg_stat_statements`, `pgcrypto`, `plpgsql`, `supabase_vault 0.3.1`, `uuid-ossp`
- Auth: `site_url = https://super.garzaos.online`, host allow-listed, `signups_enabled=true`, `mailer_autoconfirm=true` (see §5 security)
- Users: 1 (`jadengarza@pm.me`, confirmed)
- Accounts: 1 (`a99feb3f-…`, Personal, **`setup_complete_at=null`, `setup_wizard_step=0`** — onboarding never finished)
- `kortix.platform_user_roles`: **empty** (no platform admin; `/admin` will 403 once you navigate there)
- `kortix.sandboxes`: 1 row — local_docker, instance_id `cd966e33-a033-4858-ae47-fbd983468a25`
- `user_integrations` (Pipedream): 2 rows (Notion + GitHub, created today) → **account-scope only, not surfaced into sandbox plugin registry (see §2.8)**
- `credit_accounts` / `credit_ledger` / `billing_customers` — all 0 rows → any credit-gated feature will fail; this is also why the Stripe-sync error loops

### 2.8 Connectors / plugin registry — **DEGRADED**

The 2 `user_integrations` rows in Supabase (Notion + GitHub via Pipedream) represent **account-scope OAuth connections**. They are **not** auto-materialized as OpenCode plugins inside the sandbox. Observed:

- `/workspace/.opencode/opencode.jsonc` inside the sandbox contains only `{ "$schema": "https://opencode.ai/config.json" }` — 50 bytes, **no plugins configured**.
- `/workspace/.opencode/` does have `node_modules`, a `check-plugin.mjs`, and `ocx.jsonc`, so a plugin-install flow was attempted, but no plugin entries are wired in.
- In your screenshot the Kortix agent itself reports: *"this runtime currently reports no `github` / `notion` connector records, so your connected plugins appear to be in a different scope/session than this local sandbox."*
- Pipedream is reachable from the sandbox (`api.pipedream.com 200`) → not a network problem.

So the connectors are registered but **not bound** to this sandbox's plugin surface. Either the workflow that materializes account integrations into sandbox plugins hasn't been triggered yet, or the `opencode-kortix github install` / `notion install` plugin commands need to complete (the screenshot shows that command flow partially succeeding against a mock repo, then stopping at "waiting for GitHub App installation confirmation").

### 2.9 Host — **PASS (with gaps)**
- Uptime 1 h 41 min; load 0.45 / 0.94 / 1.09 (healthy on 6 vCPU)
- Mem: 17.5 GB total, 4.1 GB used, **0 swap**
- `fail2ban` inactive, `unattended-upgrades` active
- Docker: `json-file` logging, no `/etc/docker/daemon.json`, **Live Restore disabled**, no log-rotation config
- sysctl: `net.core.somaxconn=4096`, `tcp_max_syn_backlog=2048`, ephemeral ports `32768–60999` — default, fine

### 2.10 Config files + env — **PASS (one orphan)**
- `/home/ubuntu/.kortix/.env` (4 043 B, mode 0600, owner ubuntu) — VPS mode, external Supabase, all required secrets populated (OpenRouter key in, Pipedream wired, Slack empty, no SMTP)
- `/home/ubuntu/.kortix/docker-compose.yml` (1 887 B) — clean, auto-generated, `ALLOWED_SANDBOX_PROVIDERS=local_docker`, correct port bindings
- **Orphan:** `/home/ubuntu/.kortix/.api-dev.env` and `.frontend-dev.env` point at `http://83.228.213.100:13740` / `:13741` (a local Supabase that doesn't exist in this install). They're not used by the current compose — they're artifacts from a previous dev-mode run. Harmless but confusing.

---

## 3. Improvement opportunities (prioritized, no changes made)

### P0 — Directly fixes the symptoms you reported

1. **Reap / bound stale `busy` sessions inside the sandbox.** The root cause of the disconnect loop. Options:
   - Kortix-master session reaper: time out any session stuck in `busy` after N seconds and mark `errored` so the polling loop stops.
   - Add a circuit breaker in the API → sandbox proxy: if a session has returned 504 three times in a row, stop polling it for X minutes.
   - Short-term operational: a single `docker restart kortix-hosted-sandbox` clears the stuck sessions (but this is a change — **ask first**).

2. **Bind account-level Pipedream connectors into the sandbox plugin registry at session start.** Either materialize `user_integrations` rows as `opencode-kortix <name> install` on sandbox bootstrap, or have kortix-master read the integrations from Supabase and inject the tool definitions on demand. Today, two connected OAuth providers show up in the UI but the agent can't see them.

### P1 — Silent noise / correctness

3. **Fix the `[resolve-account] Stripe sync error` loop.** The billing-disabled path (`KORTIX_PUBLIC_BILLING_ENABLED=false`) still runs the Stripe customer resolver and queries a `basejump.billing_customers` row that will never exist for this account. Either gate it on the flag or upsert an empty customer row during account bootstrap.

4. **Complete the owner onboarding.** `accounts.setup_complete_at=null`, `setup_wizard_step=0`, `kortix.platform_user_roles` empty. Likely the reason no credits exist and why `/admin` will deny you. This is fixed by finishing the in-app setup wizard once logged in.

5. **Seed `credit_accounts` / `billing_customers` for the owner** (or disable credit-gating in local mode) so any credit-guarded features can run.

### P2 — Security hardening

6. **Add Caddy security headers.** HSTS, CSP (even `default-src 'self' https:` as a start), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`.

7. **Tighten signup.** Right now anyone who reaches `/auth` can create a verified account on your server (`signups_enabled=true`, `mailer_autoconfirm=true`, no captcha, no SMTP). Options: disable open signup (Supabase `disable_signup`), require email confirmation (turn off `autoconfirm`), or restrict via `uri_allow_list` + invitation-only.

8. **Enable `fail2ban`** on SSH (and ideally on 403/404 loops to Caddy). One-line install; your UFW already limits the attack surface but fail2ban closes the low-hanging SSH brute-force.

9. **Rotate SSH to key-only if not already** (I connected as `ubuntu` with the key you gave me; check `/etc/ssh/sshd_config` for `PasswordAuthentication no`).

10. **Configure SMTP for Supabase auth.** Today password-reset / confirmation emails hit Supabase's default rate-limited pool, which in practice silently drops in production. Any provider (Resend, Postmark, Amazon SES) with SPF/DKIM on `garzaos.online` fixes it.

### P3 — Reliability / ops

11. **Add Docker log rotation** via `/etc/docker/daemon.json`:
    ```json
    { "log-driver": "json-file",
      "log-opts": { "max-size": "50m", "max-file": "5" },
      "live-restore": true }
    ```
    `live-restore: true` also keeps your containers running through a daemon restart — useful on an agent host where a `docker` upgrade otherwise kills every session.

12. **Add swap.** 17 GB RAM / 0 swap means a single OpenCode runaway (I saw 5.8 GB) is one spike away from OOM-killing a container. Even 4 GB of swap gives you a buffer.

13. **Declare `healthcheck:` for each service in the compose file** so `docker ps` and any monitor can see liveness without SSH. For the API it's a 1-line `curl -f http://localhost:8008/v1/health`; for kortix-master, `curl -f http://localhost:8000/kortix/health`; for OpenCode (internal), the 4096/`healthz` equivalent.

14. **Delete the two orphan dev env files** (`.api-dev.env`, `.frontend-dev.env`) to reduce confusion for future debuggers.

15. **Add an external uptime monitor** (Uptime Kuma / Healthchecks.io / Better Uptime) on `GET /v1/health` and `GET /` with 60 s interval and alert on 3× failures. Today the only signal of the disconnect loop is the UI badge — you'd never see it from outside.

16. **Log aggregation.** At minimum, `docker compose logs` piped to a file with `logrotate`, or promtail/Loki if you want to query. The 503/504 pattern was clearly visible in logs; it should surface as a graph.

### P4 — Nice-to-haves

17. **Enable Caddy access logs** (one line in the Caddyfile) and set log rotation; right now you only get Caddy error logs in journald.

18. **Add a proper `robots.txt` and `/auth` rate-limit** via Caddy's `rate_limit` directive — again, `mailer_autoconfirm=true` + open signup is a temptation for bots.

19. **Sandbox LLM egress allowlist.** You could lock outbound HTTPS from the sandbox to just your LLM providers + Pipedream + Supabase (via a Docker network egress policy). Today outbound is open, which is fine on a trusted host but worth noting.

20. **Observability for the config-degradation UX spec.** Your spec (`docs/config-degradation-visual-handover.md`) assumes a sidebar warning when config is invalid. Today config is valid, so the UX is untested in the wild. Worth a smoke test: intentionally break `opencode.jsonc` on a throwaway sandbox and verify the warning fires.

---

## 4. Evidence appendix (condensed)

### 4.1 Sandbox busy-session loop
```
--> GET /v1/p/kortix-hosted-sandbox/8000/session/status 200 in 7-11 s
[Kortix Master] OpenCode is no longer reachable
--> GET /kortix/health 503 in 3 s
[Kortix Master] OpenCode timeout on GET /session/ses_.../message after 30 s
--> GET /session/ses_24e9bde45ffeZMC9bVbIZBTRd9/message 504 in 32 s
```
Caddy: `http.log.error msg="EOF" … status=502 err_trace=reverseproxy.statusError`

### 4.2 Sandbox resource snapshots
```
T0:  CPU 148.10 %  MEM 4.25 GiB  PIDS 1406  (busy sessions: 7)
T1:  CPU 199.73 %  MEM 5.83 GiB  PIDS 1400  (busy sessions: 7)
T2:  CPU  ~60 %     MEM ~4 GiB     PIDS ~1400 (busy sessions: 0, load normalizing)
```

### 4.3 OpenCode config (valid, but empty)
```
/workspace/.opencode/opencode.jsonc  (50 B):
  { "$schema": "https://opencode.ai/config.json" }
/config/status →
  { valid: true, loadedSources: [".../workspace/.opencode/opencode.jsonc",
                                  ".../ephemeral/kortix-master/opencode/opencode.jsonc"],
    problems: [] }
```

### 4.4 Reachability matrix
| From → To | Result |
|---|---|
| browser → super.garzaos.online | 200 + TLS valid |
| host → api.pipedream.com | 200 in 0.43 s |
| host → mcp.pipedream.com | 200 in 0.13 s |
| sandbox → api.pipedream.com | 200 in 0.40 s |
| sandbox → xwwkjguyihysjqvdwjau.supabase.co | 404 in 0.07 s (expected on bare root) |
| sandbox → api.openrouter.ai | timeout 134 s (wrong hostname — OpenRouter uses `openrouter.ai/api/v1`, not `api.openrouter.ai`; not a bug, just a probe artifact) |

### 4.5 File paths
| Path | Role | Size / mode |
|---|---|---|
| `/home/ubuntu/.kortix/docker-compose.yml` | compose | 1 887 B, 0664 |
| `/home/ubuntu/.kortix/.env` | secrets | 4 043 B, 0600 |
| `/home/ubuntu/.kortix/.api-dev.env` | orphan | 986 B, 0600 |
| `/home/ubuntu/.kortix/.frontend-dev.env` | orphan | 403 B, 0600 |
| `/home/ubuntu/.kortix/kortix` | CLI wrapper | 15 728 B, 0775 |
| `/etc/caddy/Caddyfile` | reverse proxy | 161 B |
| `/etc/docker/daemon.json` | — | **absent** |

---

## 5. What was explicitly NOT done

- No file edits
- No service restarts or `docker restart`
- No config changes
- No writes to Supabase
- No plugin installs inside the sandbox
- No UI actions as `jadengarza@pm.me` (login credentials held but not used — the dashboard UX observations in the screenshot are yours, not mine)

All findings above come from read-only commands (`docker inspect`, `docker logs`, `docker exec … curl`, `ss`, `ps`, `cat`, Supabase management API, public HTTPS probes).
