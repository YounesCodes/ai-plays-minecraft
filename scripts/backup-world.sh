#!/usr/bin/env bash
set -euo pipefail

# Archive the Paper world + key server config into ~/minecraft-lab/backups/.
#
# IMPORTANT: stop the agent and Paper BEFORE running this script so the
# world files are consistent. This script never stops (or kills) services
# itself; it only warns if they look active.
#
# Usage:
#   bash scripts/backup-world.sh [--server-dir ~/minecraft-lab/server] [--backup-dir ~/minecraft-lab/backups]
#
# Produces: backups/world-YYYY-MM-DD-HHMM.tar.gz

SERVER_DIR="${HOME}/minecraft-lab/server"
BACKUP_DIR="${HOME}/minecraft-lab/backups"

while [ $# -gt 0 ]; do
  case "$1" in
    --server-dir) SERVER_DIR="${2:?missing value}"; shift 2 ;;
    --backup-dir) BACKUP_DIR="${2:?missing value}"; shift 2 ;;
    -h|--help)
      sed -n '1,14p' "$0"
      exit 0 ;;
    *) echo "Unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
done

for d in "$SERVER_DIR/world" "$SERVER_DIR/world_nether" "$SERVER_DIR/world_the_end"; do
  if [ ! -d "$d" ]; then
    echo "Missing world directory: $d (is this the right --server-dir? Has Paper run once?)" >&2
    exit 1
  fi
done

if systemctl is-active --quiet minecraft-paper 2>/dev/null; then
  echo "WARNING: minecraft-paper service is still active. Stop it first for a clean backup:" >&2
  echo "  sudo systemctl stop minecraft-agent minecraft-paper" >&2
fi
if systemctl is-active --quiet minecraft-agent 2>/dev/null; then
  echo "WARNING: minecraft-agent service is still active. Stop it first for a clean backup." >&2
fi

mkdir -p "$BACKUP_DIR"
ARCHIVE="$BACKUP_DIR/world-$(date +%F-%H%M).tar.gz"

tar -czf "$ARCHIVE" \
  -C "$SERVER_DIR" \
  world \
  world_nether \
  world_the_end \
  server.properties \
  whitelist.json

ls -lh "$ARCHIVE"
echo "Backup written to: $ARCHIVE"
