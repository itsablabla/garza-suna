#!/usr/bin/env bash
# C4 — Install + enable fail2ban with sshd jail. Run on super.garzaos.online as a sudoer.
set -euo pipefail

if dpkg -s fail2ban >/dev/null 2>&1; then
  echo "fail2ban already installed — will still ensure jail is enabled"
else
  sudo apt-get update
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y fail2ban
fi

sudo install -m 0644 "$(dirname "$0")/C4-fail2ban-jail.local" /etc/fail2ban/jail.d/sshd.local
sudo systemctl enable --now fail2ban
sudo systemctl restart fail2ban

echo "--- verification ---"
systemctl is-active fail2ban
sudo fail2ban-client status sshd
