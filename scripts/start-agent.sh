#!/usr/bin/env bash
set -euo pipefail

# Start the agent. Configuration comes from the environment plus .env,
# which Node loads itself (--env-file never overrides real environment
# variables, so inline overrides like AGENT_MODE=benchmark npm start keep
# working). No shell parsing of .env, no eval.

if [ -z "${OPENROUTER_API_KEY:-}" ] && [ ! -f .env ]; then
  echo "WARNING: OPENROUTER_API_KEY is not set. Copy .env.example to .env and set it." >&2
fi

# World-instance namespace for coordinate memory (data/world.<id>.json).
# Ensures the active world's identity sidecar exists (creating it for
# legacy worlds touches only a tiny dotfile, never game data) and exports
# it. Never regenerated when present. Falls back to legacy shared memory
# if anything here fails — the agent must always start.
if [ -z "${AI_WORLD_ID:-}" ]; then
  AI_WORLD_ID="$(node scripts/world-id.cjs 2>/dev/null || true)"
  # Validate shape before exporting (no path traversal, ever).
  case "$AI_WORLD_ID" in
    world_*) ;;
    *) AI_WORLD_ID="" ;;
  esac
fi
if [ -n "${AI_WORLD_ID:-}" ]; then
  export AI_WORLD_ID
  echo "World instance: $AI_WORLD_ID" >&2
else
  echo "WARNING: no world-instance identity; using legacy shared world memory." >&2
fi

if [ -f .env ]; then
  exec node --env-file=.env src/index.js
else
  exec node src/index.js
fi
