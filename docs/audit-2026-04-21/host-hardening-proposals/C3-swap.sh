#!/usr/bin/env bash
# C3 — 4 GB swap file. Run on super.garzaos.online as a sudoer.
set -euo pipefail

# Guard: don't clobber an existing swap
if [[ -e /swapfile ]]; then
  echo "/swapfile already exists — abort"
  exit 1
fi
if [[ "$(swapon --show=NAME --noheadings | wc -l)" -gt 0 ]]; then
  echo "swap already active — abort"
  exit 1
fi

sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile

# Persist across reboots (idempotent)
if ! grep -qE '^/swapfile' /etc/fstab; then
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
fi

echo "--- verification ---"
free -h
grep '/swapfile' /etc/fstab || true
