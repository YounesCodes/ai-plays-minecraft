#!/usr/bin/env bash
set -euo pipefail

# Start the agent. Configuration comes from the environment plus .env,
# which Node loads itself (--env-file never overrides real environment
# variables, so inline overrides like AGENT_MODE=benchmark npm start keep
# working). No shell parsing of .env, no eval.

if [ -z "${OPENROUTER_API_KEY:-}" ] && [ ! -f .env ]; then
  echo "WARNING: OPENROUTER_API_KEY is not set. Copy .env.example to .env and set it." >&2
fi

if [ -f .env ]; then
  exec node --env-file=.env src/index.js
else
  exec node src/index.js
fi
