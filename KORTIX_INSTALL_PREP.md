# Kortix/Suna fresh-install preparation

This document captures the exact pre-install decisions and external system setup for deploying Kortix/Suna on the Garza VM.

## Target deployment
- App domain: `https://super.garzaos.online`
- Target VM: `Garza`
- IPv4: `83.228.213.100`
- IPv6: `2001:1600:18:200::3ef`
- OS: Ubuntu 24.04 LTS
- Recommended sandbox provider: `local_docker`
- Recommended DB connection mode: `Session pooler` for this project (`aws-1-us-east-1.pooler.supabase.com:5432`, user `postgres.xwwkjguyihysjqvdwjau`)
- Primary LLM provider: `OpenRouter`

## Why local_docker, not Daytona (for first install)
- Current upstream installer defaults to `local_docker`.
- Lower latency and fewer moving parts on a single dedicated VPS.
- Easier debugging during first install.
- Daytona can be added later if sandbox compute needs to be offloaded or concurrency grows.

## Supabase project (prepared)
- Project name: `kortix-prod`
- Project ref: `xwwkjguyihysjqvdwjau`
- Region: `us-east-1`
- Status: healthy

### Supabase hardening already applied
- Auth `site_url` set to `https://super.garzaos.online`
- Auth allow-list set to:
  - `https://super.garzaos.online`
  - `https://super.garzaos.online/*`
- Postgres SSL enforcement enabled
- Email auto-confirm enabled for smoother first owner signup
- DB network access restricted to the Garza VM only:
  - `83.228.213.100/32`
  - `2001:1600:18:200::3ef/128`

## Supabase values gathered
- `SUPABASE_URL`: use the new project URL for ref `xwwkjguyihysjqvdwjau`
- `SUPABASE_ANON_KEY`: captured from project API keys
- `SUPABASE_SERVICE_ROLE_KEY`: captured from project API keys
- `SUPABASE_JWT_SECRET`: provided separately during install
- `DATABASE_URL`: the working production value uses the Supabase **session pooler** connection for this project

### DB guidance
Initial assumption was that the VM's IPv6 connectivity would make the direct connection the best choice.
In practice, the direct endpoint for this project returned connection refusals from the VM during install, while the session pooler worked correctly.

Working production pattern:
```text
postgresql://postgres.xwwkjguyihysjqvdwjau:<DB_PASSWORD>@aws-1-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require
```

Other observed connection shapes from the Supabase Connect panel:
- Direct: `db.xwwkjguyihysjqvdwjau.supabase.co:5432`, user `postgres`
- Transaction pooler: `db.xwwkjguyihysjqvdwjau.supabase.co:6543`, user `postgres`
- Session pooler: `aws-1-us-east-1.pooler.supabase.com:5432`, user `postgres.xwwkjguyihysjqvdwjau`

## Other required integrations gathered
### OpenRouter
- Key validated with a real completion request
- Use as primary provider on first install

### Pipedream
- `PIPEDREAM_CLIENT_ID`: gathered
- `PIPEDREAM_CLIENT_SECRET`: gathered
- `PIPEDREAM_PROJECT_ID`: gathered

### Composio
- `COMPOSIO_API_KEY`: gathered

## DNS target
- Desired hostname: `super.garzaos.online`
- Target A record: `83.228.213.100`
- Target AAAA record: `2001:1600:18:200::3ef`
- DNS update attempted via Infomaniak API using documented zone-record endpoint.

## Fresh-VM install findings
- SSH access to the Garza VM was verified and used successfully
- Docker, `postgresql-client`, Caddy, and ufw were installed on the VM
- The official installer completed, but its external-Supabase compose output was malformed on this version because it emitted a bare top-level `volumes:` block; that had to be patched manually before `docker compose` would start
- Runtime was switched to the final public origin `https://super.garzaos.online`
- Raw app ports were rebound to `127.0.0.1` and exposed publicly only through Caddy
- TLS was issued successfully for `super.garzaos.online`
- The application and `/v1/health` are now live over HTTPS
- Final owner email is still needed for owner signup
- Final owner password is still needed for owner signup
- If the VM should ever be fully reimaged, that likely must be done via Infomaniak UI (`Reset server`), since a destructive reset endpoint was not discovered via API

## VM preparation checklist
- Confirm VM is in the desired clean state
- Ensure SSH access works
- Open firewall for `22`, `80`, `443`
- Keep raw app ports private after proxy is configured

## Install posture
- Use official upstream installer
- Use stock Dockerized runtime
- Use `local_docker`
- Use the prepared Supabase project
- Use OpenRouter first; add Daytona later only if needed

## Post-install smoke tests
At minimum verify:
- app root loads over HTTPS
- API health works
- owner signup/login works
- dashboard loads
- provider saves and health checks pass
- sandbox starts
- preview/browser/desktop open
- integrations endpoints load without 500s

## Notes
- Paid Supabase improves backup/durability posture compared with free tier.
- Because DB access is restricted to the Garza VM IPs, installs or DB checks from any other IP will fail until the allow-list is broadened.
- The upstream installer for `v0.8.44` is not fully production-complete for this external-Supabase path; it still assumes raw port exposure and required a manual compose fix plus reverse-proxy hardening.
