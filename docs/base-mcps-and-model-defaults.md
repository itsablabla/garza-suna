# Base MCPs, Anthropic provider, and `kortix-cli`

Status: shipped in PR #9.

This note documents three related changes to the sandbox image and how to
apply the equivalent on hosted kortix.com.

## 1. Base MCP set (self-hosted)

The following MCPs are now baked into
`core/kortix-master/opencode/opencode.jsonc` and attach to every agent session
on boot:

| name       | URL                                              | Auth header                                   | Env vars required                              |
|------------|--------------------------------------------------|-----------------------------------------------|------------------------------------------------|
| context7   | `https://mcp.context7.com/mcp`                   | `CONTEXT7_API_KEY: {env:CONTEXT7_API_KEY}`    | `CONTEXT7_API_KEY`                             |
| composio   | `https://connect.composio.dev/mcp`               | `x-consumer-api-key: {env:COMPOSIO_MCP_API_KEY}` | `COMPOSIO_MCP_API_KEY`                      |
| firecrawl  | `{env:FIRECRAWL_MCP_URL}`                        | `Authorization: Bearer {env:FIRECRAWL_API_KEY}`   | `FIRECRAWL_MCP_URL`, `FIRECRAWL_API_KEY`    |
| tavily     | `{env:TAVILY_MCP_URL}`                           | `Authorization: Bearer {env:TAVILY_API_KEY}`      | `TAVILY_MCP_URL`, `TAVILY_API_KEY`          |
| proton     | `https://protonmail.garzaos.cloud/mcp`           | `Authorization: Bearer {env:PROTONMAIL_MCP_TOKEN}` | `PROTONMAIL_MCP_TOKEN`                     |
| bitwarden  | `{env:VAULT_MCP_URL}`                            | `Authorization: Bearer {env:VAULT_MCP_BEARER_TOKEN}` | `VAULT_MCP_URL`, `VAULT_MCP_BEARER_TOKEN`  |
| beeper     | `{env:BEEPER_MCP_URL}`                           | `Authorization: Bearer {env:BEEPER_MCP_TOKEN}`    | `BEEPER_MCP_URL`, `BEEPER_MCP_TOKEN`        |

Tokens for services the org already runs (`VAULT_MCP_*`,
`PROTONMAIL_MCP_TOKEN`, `COMPOSIO_MCP_API_KEY`) are already provisioned as
org secrets and flow into the sandbox via `97-secrets-to-s6-env.sh`. The
`firecrawl`, `tavily`, and `beeper` entries will resolve to unreachable URLs
until the corresponding env vars are set — the MCP client logs a connect
failure per missing service, which is the intended signal.

### Rationale

Skills previously bootstrapped MCPs per-session, paying a measurable tool-call
and latency cost every time. Pinning the common set at the sandbox opencode
runtime level means every session starts with them available; skills can
still attach additional, specialised MCPs on demand.

## 2. Anthropic provider baked in

`opencode.jsonc` now also declares the `anthropic` provider with
`claude-sonnet-4-6`:

```jsonc
"anthropic": {
  "npm": "@ai-sdk/anthropic",
  "env": ["ANTHROPIC_API_KEY"],
  "options": { "apiKey": "{env:ANTHROPIC_API_KEY}" },
  "models": {
    "claude-sonnet-4-6": {
      "name": "Claude Sonnet 4.6",
      "id": "claude-sonnet-4-6",
      "family": "anthropic"
    }
  }
}
```

### Root cause for the model reset we kept seeing

When an agent adds the provider at runtime with
`PATCH /config {"model": "anthropic/claude-sonnet-4-6"}`, OpenCode writes the
provider block to `/ephemeral/kortix-master/opencode/opencode.jsonc`. Because
`/ephemeral` is replaced on image update (see the persistence contract at the
top of `core/docker/Dockerfile`), every image bump wipes the provider block.
The user's selected model still resolves against the opencode DB in
`/persistent/opencode`, but the referenced provider no longer exists → OpenCode
falls back to the first listed provider's first model → the UI shows "model
was reset".

Baking the provider into the source `opencode.jsonc` means image updates no
longer silently drop it. A 5-minute re-apply cron is *not* needed and is not
added here.

## 3. `kortix-cli`

A small helper shipped at `/usr/local/bin/kortix-cli`:

```
kortix-cli wait_for_api [--timeout=20]
kortix-cli get_config
kortix-cli list_mcp
kortix-cli get_services
kortix-cli health
```

`wait_for_api` polls both `kortix-master` (`/kortix/health`) and
`opencode-serve` (`/app`) until both respond. Use it at the top of any script
that mutates config — it eliminates the "write → verify too early → retry"
loop.

## 4. Equivalent on hosted kortix.com

Hosted kortix.com runs the upstream image, so the bake above does not apply.
Hosted has no public REST endpoint for MCP CRUD (all probed paths return 404),
so configuration is UI-only today:

1. Open https://kortix.com/settings/connections/mcp.
2. For each entry in the table above, click "Add MCP server" and fill in:
   - Transport: HTTP (Streamable HTTP)
   - URL: the column above (no env substitution on hosted — paste literal)
   - Headers: one per line, same format (substitute actual secret values)
3. Save.

Secrets pasted this way live only in hosted's settings DB. Rotate them in
both places (self-hosted via `~/.kortix/.env`, hosted via the UI) whenever
credentials change.

If kortix.com later exposes a public MCP admin API, port the equivalent
`kortix-cli hosted-sync` helper — stub it here and revisit.
