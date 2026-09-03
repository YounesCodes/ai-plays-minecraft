#!/usr/bin/env bash
set -euo pipefail

# Load .env through the shell (no dotenv dependency).
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

if [ -z "${OPENROUTER_API_KEY:-}" ]; then
  echo "WARNING: OPENROUTER_API_KEY is not set. Copy .env.example to .env and set it." >&2
fi

exec node src/index.js
