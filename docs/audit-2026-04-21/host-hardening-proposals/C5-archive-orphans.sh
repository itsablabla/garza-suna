#!/usr/bin/env bash
# C5 — Archive orphan dev-mode env files. Run on super.garzaos.online as the .kortix owner.
# Reversible via `mv` back from ~/.kortix/archive/.
set -euo pipefail

KORTIX_DIR="${HOME}/.kortix"
ARCHIVE_DIR="${KORTIX_DIR}/archive"

mkdir -p "$ARCHIVE_DIR"

for f in .api-dev.env .frontend-dev.env; do
  src="${KORTIX_DIR}/${f}"
  if [[ -f "$src" ]]; then
    mv "$src" "${ARCHIVE_DIR}/${f}.$(date -u +%Y%m%dT%H%M%SZ)"
    echo "archived: $f"
  else
    echo "already absent: $f"
  fi
done

echo "--- verification ---"
# Confirm compose still parses
docker compose -f "${KORTIX_DIR}/docker-compose.yml" config > /dev/null && echo "docker compose config: OK"
# Confirm containers still Up
docker ps --format 'table {{.Names}}\t{{.Status}}' | grep -E 'kortix|^NAMES'
