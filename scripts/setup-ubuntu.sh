#!/usr/bin/env bash
set -euo pipefail

# Ubuntu VM setup: Node.js 22 + project dependencies.
# Run from the repository root: bash scripts/setup-ubuntu.sh
#
# This script only handles the Node.js side. Full VM provisioning
# (Java, Paper, firewall, systemd) is documented in docs/vm-setup.md.

NEEDS_NODE=0
if ! command -v node >/dev/null 2>&1; then
  NEEDS_NODE=1
else
  MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "${MAJOR:-0}" -lt 22 ]; then
    echo "Node $(node --version) is older than the required v22; upgrading..." >&2
    NEEDS_NODE=1
  else
    echo "Node found: $(node --version)"
  fi
fi

if [ "$NEEDS_NODE" = "1" ]; then
  echo "Installing Node.js 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs git curl
fi

echo "Node: $(node --version)  npm: $(npm --version)"

echo "Installing npm dependencies..."
npm install

echo "Done. Next: cp .env.example .env and edit .env"
