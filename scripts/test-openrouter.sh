#!/usr/bin/env bash
set -euo pipefail

# Smoke-test the OpenRouter API key / model without starting the bot.

# Load .env (no dotenv dependency). Variables already in the environment
# take precedence, so inline overrides are not clobbered by .env.
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

: "${OPENROUTER_API_KEY:?Set OPENROUTER_API_KEY in .env first}"
MODEL="${OPENROUTER_MODEL:-openrouter/free}"
APP_NAME="${OPENROUTER_APP_NAME:-AI Plays Minecraft}"

curl -sS https://openrouter.ai/api/v1/chat/completions \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -H "Content-Type: application/json" \
  -H "X-Title: $APP_NAME" \
  -d "$(printf '{"model":"%s","messages":[{"role":"user","content":"Reply with the single word: ok"}],"temperature":0}' "$MODEL")" \
  | head -c 2000
echo
