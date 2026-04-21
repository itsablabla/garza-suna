# Kortix/Suna fresh-install preparation

This document captures the exact pre-install decisions and external system setup for deploying Kortix/Suna on the Garza VM.

## Target deployment
- App domain: `https://super.garzaos.online`
- Target VM: `Garza`
- IPv4: `83.228.213.100`
- IPv6: `2001:1600:18:200::3ef`
- OS: Ubuntu 24.04 LTS
- Recommended sandbox provider: `local_docker`
- Recommended DB connection mode: `Direct` (VM has IPv6)
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
- `SUPABASE_JWT_SECRET`: captured from PostgREST config
- `DATABASE_URL`: use **Direct** connection with the known DB password for the new project

### DB guidance
Because the Garza VM has IPv6, use direct connection rather than the IPv4 pooler fallback.

Direct pattern:
```text
postgresql://postgres:<DB_PASSWORD>@db.xwwkjguyihysjqvdwjau.supabase.co:5432/postgres
```

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

## Remaining inputs needed before install
- SSH access to the Garza VM
- Final owner email
- Final owner password
- If the VM should be fully reimaged, that likely must be done via Infomaniak UI (`Reset server`), since a destructive reset endpoint was not discovered via API

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
