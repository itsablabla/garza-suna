# Host hardening proposals (Phase C)

Each of these is a small, reversible, independently-committable change to `super.garzaos.online` that closes a specific P2/P3 item from the audit. None of them touch Kortix source.

Each proposal is paired with a `.current` file captured from the live host on 2026-04-21 so the diff is against reality, not assumption.

| ID | What | Risk | Reversal |
|----|------|------|----------|
| C1 | Caddy security headers + access log | Low — headers are additive; new log dir is created; existing reverse proxies unchanged | `mv Caddyfile.bak /etc/caddy/Caddyfile && systemctl reload caddy` |
| C2 | `/etc/docker/daemon.json` with log rotation + `live-restore` | Low — new file, `live-restore` only takes effect on next daemon start, rotation applies to new containers only | `rm /etc/docker/daemon.json && systemctl reload docker` |
| C3 | 4 GB swap file | Low — host has 0 B swap today, adds disk-backed paging cushion | `swapoff /swapfile && rm /swapfile && remove fstab line` |
| C4 | `fail2ban` with sshd jail (3 fails in 10 min = 1 h ban) | Low — does not affect key-based logins from trusted IPs, only rate-limits brute force | `systemctl disable --now fail2ban && apt remove fail2ban` |
| C5 | Archive orphan `.api-dev.env` / `.frontend-dev.env` | Low — files not referenced by current VPS-mode compose | `mv archive/* back to ~/.kortix/` |

## Verification per item

| ID | Verification command | Expected |
|----|---------------------|----------|
| C1 | `curl -sI https://super.garzaos.online/` | `strict-transport-security`, `x-frame-options`, `x-content-type-options`, `referrer-policy`, `permissions-policy` all present; `server` header absent |
| C2 | `docker info \| grep -A2 'Logging Driver'; cat /etc/docker/daemon.json` | `log-opts max-size 50m`; file matches proposal |
| C3 | `free -h \| awk '/Swap/ {print $2}'; grep swapfile /etc/fstab` | `4.0Gi`; fstab line present |
| C4 | `systemctl is-active fail2ban; fail2ban-client status sshd` | `active`; `Status for the jail: sshd` with `Currently failed: 0` |
| C5 | `ls ~/.kortix/archive/; docker ps --format 'table {{.Names}}\t{{.Status}}'` | archive files present with timestamp suffix; all 3 containers still `Up` |

## Ordering

1. **C5** first (cheapest; pure filesystem move)
2. **C1** (Caddy reload, 2 sec)
3. **C3** (swap; purely additive)
4. **C4** (install + enable fail2ban)
5. **C2** (daemon.json; safest last because `live-restore` change is the one most likely to surprise)

Each change is its own commit; if any fails verification, the run stops and the change is reverted.

## What we are explicitly NOT doing in this pass

- **CSP header** — deferred. Needs to be built against actual Next.js / connector endpoints and observed in `Content-Security-Policy-Report-Only` mode before enforcing. Would take its own spec + a day of observation.
- **Rate-limiting in Caddy** — deferred. Needs Caddy with `caddy-ratelimit` plugin or an external WAF; not a drop-in config change.
- **Docker daemon restart** — avoided. `systemctl reload docker` picks up `daemon.json` without killing containers; `live-restore: true` takes effect on next daemon start event.
