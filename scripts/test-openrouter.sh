#!/usr/bin/env bash
set -euo pipefail

# Smoke-test the OpenRouter API key / model without starting the bot.

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
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
