#!/usr/bin/env bun
/**
 * kortix-cli — small helper for interacting with the sandbox's kortix-master
 * and opencode-serve. Exists to eliminate the "verify → fail → retry" loop
 * that plagued ad-hoc scripts by providing a single `wait_for_api` entry point
 * plus cached getters.
 *
 * Entry points:
 *   kortix-cli wait_for_api [--timeout=20]
 *   kortix-cli get_config
 *   kortix-cli list_mcp
 *   kortix-cli get_services
 *   kortix-cli health
 *
 * All commands exit 0 on success, non-zero on timeout/error, and emit JSON on
 * stdout. Designed for use from shell scripts and from the opencode agent
 * session itself (baked into the image at /usr/local/bin/kortix-cli).
 */

const KM_BASE = process.env.KORTIX_MASTER_URL ?? 'http://localhost:8000'
const OC_BASE = process.env.OPENCODE_URL ?? 'http://localhost:4096'

async function fetchJson(url: string, init?: RequestInit, timeoutMs = 5000) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const r = await fetch(url, { ...init, signal: ac.signal })
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
    return await r.json()
  } finally {
    clearTimeout(t)
  }
}

async function waitForApi(timeoutSec: number) {
  const deadline = Date.now() + timeoutSec * 1000
  let lastErr: unknown = null
  while (Date.now() < deadline) {
    try {
      await fetchJson(`${KM_BASE}/kortix/health`, undefined, 2000)
      await fetchJson(`${OC_BASE}/app`, undefined, 2000)
      return { ok: true, waitedMs: timeoutSec * 1000 - (deadline - Date.now()) }
    } catch (e) {
      lastErr = e
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  throw new Error(`wait_for_api timeout after ${timeoutSec}s: ${String(lastErr)}`)
}

async function getConfig() {
  return fetchJson(`${OC_BASE}/config`)
}

async function listMcp() {
  const cfg = await getConfig()
  const mcp = (cfg && typeof cfg === 'object' && 'mcp' in cfg && cfg.mcp) || {}
  return Object.entries(mcp as Record<string, unknown>).map(([name, spec]) => ({
    name,
    spec,
  }))
}

async function getServices() {
  return fetchJson(`${KM_BASE}/kortix/services`)
}

async function health() {
  return fetchJson(`${KM_BASE}/kortix/health`)
}

function parseArgs(argv: string[]) {
  const [, , cmd, ...rest] = argv
  const flags: Record<string, string> = {}
  for (const arg of rest) {
    const m = /^--([^=]+)=(.*)$/.exec(arg)
    if (m) flags[m[1]] = m[2]
  }
  return { cmd, flags }
}

async function main() {
  const { cmd, flags } = parseArgs(process.argv)
  let result: unknown
  switch (cmd) {
    case 'wait_for_api':
      result = await waitForApi(Number(flags.timeout ?? '20'))
      break
    case 'get_config':
      result = await getConfig()
      break
    case 'list_mcp':
      result = await listMcp()
      break
    case 'get_services':
      result = await getServices()
      break
    case 'health':
      result = await health()
      break
    default:
      console.error(
        'Usage: kortix-cli <wait_for_api|get_config|list_mcp|get_services|health> [--timeout=20]',
      )
      process.exit(2)
  }
  console.log(JSON.stringify(result, null, 2))
}

main().catch((e: unknown) => {
  console.error(`[kortix-cli] ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
