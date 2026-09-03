#!/usr/bin/env bash
set -euo pipefail

# Download a pinned Paper server build into ~/minecraft-lab/server/paper.jar.
#
# Usage:
#   bash scripts/install-paper.sh [--mc-version 1.21.11] [--server-dir ~/minecraft-lab/server] [--force]
#
# - Pins the Minecraft version (default 1.21.11). Never downloads "latest".
# - Refuses to overwrite an existing paper.jar unless --force is given.
# - Never touches server.properties and never accepts the EULA.
#
# Requires: curl, jq.

MC_VERSION="1.21.11"
SERVER_DIR="${HOME}/minecraft-lab/server"
FORCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --mc-version) MC_VERSION="${2:?missing value}"; shift 2 ;;
    --server-dir) SERVER_DIR="${2:?missing value}"; shift 2 ;;
    --force) FORCE=1; shift ;;
    -h|--help)
      sed -n '1,12p' "$0"
      exit 0 ;;
    *) echo "Unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
done

for cmd in curl jq; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
done

mkdir -p "$SERVER_DIR"

if [ -f "$SERVER_DIR/paper.jar" ] && [ "$FORCE" -ne 1 ]; then
  echo "Refusing to overwrite existing $SERVER_DIR/paper.jar (pass --force to replace it)." >&2
  exit 1
fi

PROJECT="paper"
USER_AGENT="ai-plays-minecraft/1.0 (private-homelab)"

echo "Querying Paper builds for Minecraft $MC_VERSION ..."
BUILDS="$(curl -fsSL \
  -H "User-Agent: $USER_AGENT" \
  "https://fill.papermc.io/v3/projects/${PROJECT}/versions/${MC_VERSION}/builds")"

PAPER_URL="$(echo "$BUILDS" | jq -r \
  'first(.[] | select(.channel == "STABLE") | .downloads."server:default".url) // empty')"
BUILD_ID="$(echo "$BUILDS" | jq -r \
  'first(.[] | select(.channel == "STABLE") | .id) // empty')"

test -n "$PAPER_URL" || {
  echo "No STABLE Paper build found for Minecraft $MC_VERSION" >&2
  exit 1
}

echo "Downloading Paper $MC_VERSION build $BUILD_ID ..."
curl -fL \
  -H "User-Agent: $USER_AGENT" \
  "$PAPER_URL" \
  -o "$SERVER_DIR/paper.jar"

ls -lh "$SERVER_DIR/paper.jar"
echo "Downloaded Paper $MC_VERSION (build $BUILD_ID) to $SERVER_DIR/paper.jar"
echo "Next: first launch + EULA, see docs/vm-setup.md section 9."
