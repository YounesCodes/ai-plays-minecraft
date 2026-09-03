#!/usr/bin/env bash
set -euo pipefail

# Load .env through the shell (no dotenv dependency).
# Variables already present in the environment take precedence, so inline
# overrides like `AGENT_MODE=benchmark npm start` are not clobbered by .env.
if [ -f .env ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    # Skip blank lines and comments.
    stripped="$(printf '%s' "$line" | sed -e 's/^[[:space:]]*//')"
    case "$stripped" in ''|\#*) continue ;; esac
    # Tolerate an optional leading `export`.
    case "$stripped" in export\ *|export\t*) stripped="$(printf '%s' "$stripped" | sed -e 's/^export[[:space:]]*//')" ;; esac
    case "$stripped" in *=*) ;; *) continue ;; esac
    var="${stripped%%=*}"
    var="$(printf '%s' "$var" | sed -e 's/[[:space:]]*$//')"
    case "$var" in ''|*[!A-Za-z0-9_]* ) continue ;; esac
    if eval "[ -n \"\${${var}+x}\" ]"; then
      continue # already set in the environment; keep the caller's value
    fi
    eval "export $stripped"
  done < .env
fi

if [ -z "${OPENROUTER_API_KEY:-}" ]; then
  echo "WARNING: OPENROUTER_API_KEY is not set. Copy .env.example to .env and set it." >&2
fi

exec node src/index.js
