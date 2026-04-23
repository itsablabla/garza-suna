import { getEnv } from "../opencode/tools/lib/get-env.js"

/**
 * Parse SANDBOX_PORT_MAP env var into a Record<containerPort, hostPort>.
 * Format: JSON object, e.g. {"8000":"14000","6080":"14002"}
 */
function parsePortMap(): Record<string, string> {
  const raw = process.env.SANDBOX_PORT_MAP
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    console.warn('[Kortix Master] Failed to parse SANDBOX_PORT_MAP:', raw)
    return {}
  }
}

export const config = {
  // Kortix Master port (main entry point)
  PORT: parseInt(process.env.KORTIX_MASTER_PORT || '8000'),

  // OpenCode server (proxied, always unprotected)
  OPENCODE_HOST: process.env.OPENCODE_HOST || 'localhost',
  OPENCODE_PORT: parseInt(process.env.OPENCODE_PORT || '4096'),

  // ─── Kortix Backend ─────────────────────────────────────────────────────────
  // KORTIX_API_URL: base URL of kortix-api. Source of truth is the secrets-manager-
  // backed s6 env file when present; process.env/.env are fallbacks for native dev.
  get KORTIX_API_URL() { return getEnv('KORTIX_API_URL') || 'http://localhost:8008' },

  // KORTIX_TOKEN — direction: sandbox → kortix-api.
  // Source of truth is the secrets-manager-backed s6 env file. This allows token
  // rotation and sync without trusting stale container process.env values.
  get KORTIX_TOKEN() { return getEnv('KORTIX_TOKEN') || '' },

  // Feature flag: enable or disable local deployment routes (/kortix/deploy/*)
  KORTIX_DEPLOYMENTS_ENABLED: process.env.KORTIX_DEPLOYMENTS_ENABLED === 'true',

  // ─── B.core: circuit-breaker + stuck-session reaper ────────────────────────
  // Circuit-breaker for the OpenCode proxy. When the upstream emits N consecutive
  // transient failures (timeout / connection refused / 5xx on non-file-status
  // paths) the breaker trips open and subsequent calls fast-fail with 503
  // "recovering" instead of the caller seeing 30s hangs / 502s. Default OFF
  // until verified on prod; flip to 'true' in ~/.kortix/.env on the host.
  KORTIX_CIRCUIT_BREAKER_ENABLED: process.env.KORTIX_CIRCUIT_BREAKER_ENABLED === 'true',
  KORTIX_CIRCUIT_BREAKER_FAILURE_THRESHOLD: parseInt(process.env.KORTIX_CIRCUIT_BREAKER_FAILURE_THRESHOLD || '5'),
  KORTIX_CIRCUIT_BREAKER_COOLDOWN_MS: parseInt(process.env.KORTIX_CIRCUIT_BREAKER_COOLDOWN_MS || '15000'),

  // Stuck-session reaper. Activity-based: a session is only flagged when it has
  // been NON-idle AND emitted zero observable activity for idleMs AND is older
  // than minAgeMs AND is NOT marked noReap in session metadata. Default OFF.
  KORTIX_SESSION_REAPER_ENABLED: process.env.KORTIX_SESSION_REAPER_ENABLED === 'true',
  KORTIX_SESSION_IDLE_MS: parseInt(process.env.KORTIX_SESSION_IDLE_MS || '600000'),
  KORTIX_SESSION_MIN_AGE_MS: parseInt(process.env.KORTIX_SESSION_MIN_AGE_MS || '60000'),
  KORTIX_SESSION_SCAN_INTERVAL_MS: parseInt(process.env.KORTIX_SESSION_SCAN_INTERVAL_MS || '30000'),

  // Prophylactic OpenCode recycler. The hosted Kortix sandbox doesn't wedge
  // because each project sandbox is short-lived — spun up on demand, torn
  // down when idle. Self-hosted runs opencode-serve for hours, accumulating
  // state that eventually deadlocks. This primitive mimics the hosted
  // lifecycle by proactively respawning opencode-serve once it has been
  // running > maxAgeMs AND there are zero non-idle sessions. Always gated
  // on idleness — never interrupts a live stream. Default OFF so prod can
  // observe the ticker's snapshot output before flipping the switch.
  KORTIX_OPENCODE_RECYCLER_ENABLED: process.env.KORTIX_OPENCODE_RECYCLER_ENABLED === 'true',
  KORTIX_OPENCODE_RECYCLER_MAX_AGE_MS: parseInt(process.env.KORTIX_OPENCODE_RECYCLER_MAX_AGE_MS || '21600000'), // 6h
  KORTIX_OPENCODE_RECYCLER_MIN_INTERVAL_MS: parseInt(process.env.KORTIX_OPENCODE_RECYCLER_MIN_INTERVAL_MS || '3600000'), // 1h
  KORTIX_OPENCODE_RECYCLER_SCAN_INTERVAL_MS: parseInt(process.env.KORTIX_OPENCODE_RECYCLER_SCAN_INTERVAL_MS || '60000'), // 1min

  // Secret storage
  SECRET_FILE_PATH: process.env.SECRET_FILE_PATH || `${process.env.KORTIX_PERSISTENT_ROOT || '/persistent'}/secrets/.secrets.json`,
  SALT_FILE_PATH: process.env.SALT_FILE_PATH || `${process.env.KORTIX_PERSISTENT_ROOT || '/persistent'}/secrets/.salt`,
  ENCRYPTION_KEY_PATH: process.env.ENCRYPTION_KEY_PATH || `${process.env.KORTIX_PERSISTENT_ROOT || '/persistent'}/secrets/.encryption-key`,

  // Sandbox metadata
  SANDBOX_ID: process.env.SANDBOX_ID || '',
  PROJECT_ID: process.env.PROJECT_ID || '',

  // INTERNAL_SERVICE_KEY — direction: external → sandbox.
  // This is how kortix-api (and other external callers) authenticates TO the sandbox.
  // Every inbound request from outside the container must include this as a Bearer token.
  // Validated by the global auth middleware in index.ts.
  // Localhost requests (from inside the sandbox) bypass auth entirely — no token needed.
  // Counterpart: KORTIX_TOKEN goes the other direction (sandbox → kortix-api).
  // Auto-generates if not provided — external access is ALWAYS auth-protected.
  // In normal operation, kortix-api injects the key as a Docker env var.
  get INTERNAL_SERVICE_KEY(): string {
    const s6EnvDir = process.env.S6_ENV_DIR || '/run/s6/container_environment'
    // Always re-read from s6 env dir first — kortix-api may have written it
    // via docker exec after we started (the fallback sync path). Reading from
    // the file ensures we pick up the injected value without a restart.
    const s6Path = `${s6EnvDir}/INTERNAL_SERVICE_KEY`
    try {
      const { readFileSync } = require('fs')
      const val = readFileSync(s6Path, 'utf8').trim()
      if (val) {
        process.env.INTERNAL_SERVICE_KEY = val
        return val
      }
    } catch {
      // file not present yet — fall through
    }

    const tokenAlias = getEnv('KORTIX_TOKEN') || process.env.KORTIX_TOKEN || ''
    if (tokenAlias) {
      process.env.INTERNAL_SERVICE_KEY = tokenAlias
      return tokenAlias
    }

    if (!process.env.INTERNAL_SERVICE_KEY) {
      console.warn(
        '[Kortix Master] WARNING: No INTERNAL_SERVICE_KEY or KORTIX_TOKEN available.\n' +
        '  Sandbox auth will fail until the canonical sandbox token is synced.'
      )
    }
    return process.env.INTERNAL_SERVICE_KEY || ''
  },

  // Container-port → host-port mappings (set by docker-compose)
  PORT_MAP: parsePortMap(),
}
