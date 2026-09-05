# AI Plays Minecraft

## First-time deployment (new VM)

This section is the self-contained short path from empty VM to running agent:

1. Provision an Ubuntu 24.04 VM (4 vCPU, 8 GB RAM, 40–60 GB disk) on your LAN.
2. `sudo apt update && sudo apt upgrade -y`, then install base tools:
   `sudo apt install -y curl wget git jq unzip tmux ufw ca-certificates gnupg`.
3. Java 21: `sudo apt install -y openjdk-21-jre-headless` → `java -version`.
4. Node.js 22+: `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -`
   then `sudo apt install -y nodejs` → `node --version` must be ≥ v22
   (or run `bash scripts/setup-ubuntu.sh` from the repo for the Node step).
5. `mkdir -p ~/minecraft-lab/server ~/minecraft-lab/backups`.
6. Download Paper **1.21.11** into `~/minecraft-lab/server`
   (`bash scripts/install-paper.sh` from the repo, or query the Paper
   downloads API with `jq` and save the STABLE build as `paper.jar` — pin
   1.21.11, never "latest"). Launch once to generate files, accept the EULA.
7. `server.properties`: `server-port=25565`, `online-mode=false`,
   `white-list=true`, `enforce-secure-profile=false`, `spawn-protection=0`,
   `max-players=5`, `view-distance=10`, `simulation-distance=8`. Restart Paper
   after changes. ⚠️ `online-mode=false` means usernames are NOT verified —
   keep the server LAN-only (no router port-forward); whitelist + firewall
   are the access control.
8. Whitelist the bot and yourself in the Paper console
   (`whitelist add Agent01`, `whitelist add <your-name>`), start Paper, and
   join from a plain vanilla 1.21.11 client to prove the server works before
   involving the agent.
9. Firewall: allow SSH first, then
   `sudo ufw allow from <your-LAN-subnet> to any port 25565 proto tcp`;
   `sudo ufw enable`; verify with `sudo ufw status verbose`.
10. `git clone <url> ~/minecraft-lab/ai-plays-minecraft`, `npm ci`,
    `cp .env.example .env` and set `OPENROUTER_API_KEY`
    (`OPENROUTER_MODEL=openrouter/free`), `MC_HOST=127.0.0.1`,
    `MC_USERNAME=Agent01`, `MC_VERSION=1.21.11`, `AGENT_MODE=autonomous`.
    Inline variables override `.env`, so `AGENT_MODE=benchmark npm start`
    works even when `.env` says `autonomous`.
11. `npm run test:openrouter` → `npm test` →
    `AGENT_MODE=benchmark npm start` → `AGENT_MODE=autonomous npm start`.

Headless Minecraft AI agent. A Mineflayer bot connects to a local Paper
1.21.11 server; an OpenRouter LLM performs cognition (goals, plans, skills,
reflection); trusted deterministic primitives do the Minecraft work.

Two modes:

- `AGENT_MODE=autonomous` (default, main mode): the agent chooses its own
  goals, plans with trusted primitives and reusable declarative skills,
  learns from experience via reflection + JSON memory, and survives/progresses.
- `AGENT_MODE=benchmark`: deterministic regression test —
  **collect 8 logs without dying** (legacy sense→plan→act loop, preserved).

## VM layout

The repo lives at `~/minecraft-lab/ai-plays-minecraft`. The world, Paper JAR,
and backups stay outside the repo:

```
~/minecraft-lab/
├── server/              # paper.jar, server.properties, world/, logs/
├── ai-plays-minecraft/  # this repository
├── world-snapshots/     # stored full world dirs (benchmark switching)
└── backups/
```

## Benchmark worlds

Two concepts, never mixed automatically:

- **Autonomy world** (the live `server/world`): persistent learning,
  memories, deaths, progression. The current abused/depleted lab world is
  deliberately kept as the hostile/stressed test world.
- **Clean benchmark world**: fresh regen from the fixed seed `20260904`
  for deterministic movement/resource tests.

`scripts/benchmark-world.sh` swaps between them. It never deletes
anything (the active world is always stashed first) and refuses to run
unless Paper is stopped AND `--confirm` is passed:

```bash
scripts/benchmark-world.sh status
scripts/benchmark-world.sh prepare fresh --confirm --seed 20260904
scripts/benchmark-world.sh restore <snapshot-name> --confirm
```

Locomotion TEST A–F run via `node scripts/locomotion-bench.cjs --origin
"X,Y,Z"` (prints the exact Paper console arena commands, then measures
flat/rise/stairs/pillar/wall/ditch legs with JSONL telemetry).

## Prerequisites (Ubuntu VM on Proxmox)

- Node.js 22+
- Paper 1.21.11 server on `127.0.0.1:25565`, offline auth, e.g.
  `online-mode=false` in `server.properties` for local testing
- An OpenRouter API key

## Setup

```bash
git clone <url> ~/minecraft-lab/ai-plays-minecraft
cd ~/minecraft-lab/ai-plays-minecraft
bash scripts/setup-ubuntu.sh
cp .env.example .env
# edit .env: set OPENROUTER_API_KEY, AGENT_MODE=autonomous
```

## Run

```bash
AGENT_MODE=autonomous npm start
# or: AGENT_MODE=benchmark npm start   # deterministic regression test
# or: bash scripts/start-agent.sh
```

Test the LLM key without starting the bot:

```bash
npm run test:openrouter
```

Run unit tests (Node built-in runner, no network/minecraft needed):

```bash
npm test
```

Syntax check:

```bash
npm run check
```

## Configuration (.env)

| Key | Default | Meaning |
| --- | ------- | ------- |
| `OPENROUTER_API_KEY` | — | Required. Never logged. |
| `OPENROUTER_MODEL` | `openrouter/free` | Model id. Preferred serious autonomy model: `deepseek/deepseek-v4-flash-0731` (A/B-evaluated). `mistralai/mistral-nemo` remains a cheap lightweight baseline for synthetic checks. |
| `AUTONOMOUS_MAX_TOKENS` | `1536` | Planner output budget. DeepSeek completions measured p95=826, max=1137 tokens. |
| `REFLECTION_MAX_TOKENS` | `1024` | Separate reflection output budget. |
| `OPENROUTER_APP_NAME` | `AI Plays Minecraft` | Sent as `X-Title`. |
| `OPENROUTER_TIMEOUT_MS` | 60000 | HTTP timeout per LLM call (ms). |
| `MC_HOST` / `MC_PORT` | `127.0.0.1` / `25565` | Paper server. |
| `MC_USERNAME` | `Agent01` | Offline-auth bot name. |
| `MC_VERSION` | `1.21.11` | Must match server. |
| `AGENT_MODE` | `autonomous` | `autonomous` or `benchmark`. |
| `AGENT_DIRECTIVE` | Survive and progress… | Long-term autonomous directive. |
| `AGENT_GOAL` | Collect 8 logs… | Benchmark goal (benchmark mode). |
| `MAX_AGENT_STEPS` | 0 (unlimited) | Loop bound; `0` = run forever. Benchmark uses its own default when `0`. |
| `DECISION_DELAY_MS` | 1000 | Pause between steps. |
| `OBSERVATION_RADIUS` | 24 | Entity scan radius. |
| `MAX_NEARBY_ENTITIES` | 20 | Entity cap per observation. |
| `MAX_INTERESTING_BLOCKS` | 30 | Block cap per perception scan. |
| `MAX_BLOCK_SEARCH_DISTANCE` | 64 | Block search radius. |
| `MAX_LOG_COLLECTION_AMOUNT` | 8 | Per-action cap (benchmark). |
| `MAX_SKILL_STEPS` | 12 | Max primitives per declarative skill. |
| `MAX_SKILLS` | 200 | Skill library bound. |
| `MAX_SEMANTIC_MEMORIES` | 500 | Semantic store bound. |
| `MAX_EPISODIC_MEMORIES` | 500 | Episodic store bound. |
| `MAX_WORLD_MEMORIES` | 500 | World store bound. |
| `REFLECTION_ENABLED` | true | LLM reflection after meaningful events. |
| `MEMORY_ENABLED` | true | JSON memory persistence. |
| `SKILL_GENERATION_ENABLED` | true | LLM skill proposals. |
| `PRIMITIVE_TIMEOUT_MS` | 30000 | Per-primitive timeout. |
| `SKILL_TIMEOUT_MS` | 120000 | Per-skill timeout. |
| `BLOCK_SCAN_THROTTLE_MS` | 5000 | Block-scan cache window. |
| `MOVEMENT_STALL_WINDOW_MS` | 4000 | No-progress window before a move is declared stalled. |
| `MOVEMENT_STALL_MIN_PROGRESS` | 0.3 | Blocks of movement resetting the stall window. |
| `EXPLORE_MAX_DISTANCE` | 64 | Cap for explore waypoints. |
| `MAX_CONSECUTIVE_PLANNER_FAILURES` | 5 | Circuit-breaker threshold. |
| `PLANNER_BACKOFF_BASE_MS` | 2000 | Retry backoff base. |
| `MAX_CHASE_DISTANCE` | 32 | Combat chase bound. |
| `MAX_ATTACK_SECONDS` | 20 | Combat duration bound. |

## How it works (autonomous)

```
Minecraft -> Perception -> Interrupts -> Memory retrieval -> Cognition
  -> Goals + Planning -> Validated skill/primitive -> Mineflayer
  -> Outcome -> Reflection -> Memory -> replan
```

1. `src/bot/observations.js` (+ `perception.js`) builds a compact bounded
   JSON snapshot: health/food/armor, equipment + durability, position,
   dimension, fire/underwater, time + day/night, weather, light, bounded
   inventory, nearby entities (id/type/distance/hostile), interesting blocks
   (logs, tables, furnaces, beds, chests, coal/iron/diamond, water, lava),
   known locations nearby. Raw Mineflayer objects never reach the LLM.
   Block scanning is throttled + cached.
2. `src/bot/interrupts.js` deterministically flags urgent situations
   (critical health/hunger, immediate hostile threat, fire, death) — no LLM
   call needed. Urgent interrupts suspend the current goal and force
   emergency replanning.
3. `src/memory/retrieval.js` fetches only relevant memories (keyword/entity
   matching over goal, nearby mobs/blocks, failures, equipment, danger —
   e.g. creeper nearby → creeper/combat/retreat memories).
4. `src/agent/cognition.js` decides whether an LLM call is even needed
   (skips routine deterministic progress), `src/agent/planner.js` requests a
   rich planning object (assessment + goal + plan + nextStep + optional
   skill/memory proposals), and the output is strictly validated.
5. `src/agent/actions.js` executes exactly one meaningful `nextStep` —
   a trusted primitive via `src/primitives/` or a validated declarative
   skill via `src/skills/executor.js`. Plans are intentions, not scripts:
   after each step we re-observe.
6. Outcomes update skill scores (`src/skills/scorer.js`); meaningful events
   (death, combat, failures, discoveries, milestones) trigger
   `src/agent/reflection.js`, which may store semantic/episodic memories,
   suggest goal changes, or propose skill revisions. Reflection output is
   validated and can never write files or run code directly.

## Trusted primitives (Level 1, implemented by us)

Movement: `move_near`, `move_near_entity`, `move_away_from_entity`,
`stop_movement`. Perception: `find_block`, `find_entity`. Combat:
`equip_best_melee_weapon`, `attack_entity` (bounded chase/duration),
`stop_attacking`. Inventory: `equip_item`, `inspect_inventory`. Survival:
`eat_best_food`, `sleep`, `wait`. Mining: `mine_block`, `mine_block_type`
(reports `blockBroken`/`dropObtained` so the agent can learn tool tiers).
Crafting: `craft_item`. Interaction: `place_block`, `use_item`, `chat`.

Every primitive has a fixed name, argument schema, validation
(`src/safety/primitiveValidator.js`), timeout, bounded behavior, and a
structured `{ ok, ... }` result. The LLM cannot invent primitives.

## Declarative skills (Level 2, LLM-created data)

Skills are pure JSON: `{ id, name, description, parameters, steps[] }` where
each step is `{ primitive, args }` with `$param` substitution. Validated by
`src/safety/skillValidator.js` (rejects unknown primitives, bad args, unknown
`$refs`, >12 steps, and any code/shell/path/URL/env/loop/recursion payload),
stored in `src/skills/library.js` (`data/skills.json`), executed by
`src/skills/executor.js` (ordered, fail-fast, timeout, interrupt abortion),
scored by `src/skills/scorer.js` (success/failure counts + score; repeated
failures rank lower). Skills are DATA — never generated JavaScript, never
`eval`'d. See `src/skills/generator.js` for the proposal prompt format.

## Memory (JSON persistence in `data/`, survives restarts)

- Semantic (`data/semantic.json`): general facts, e.g. creepers explode,
  stone pickaxes don't yield diamond. Deduplicated, confidence-scored,
  pruned to `MAX_SEMANTIC_MEMORIES`.
- Episodic (`data/episodic.json`): important experiences with context +
  lesson (deaths, fights, discoveries). Bounded.
- Procedural (`data/procedural.json`): per-skill success/failure records.
- World (`data/world.json`): named locations (shelter, mine, diamond vein,
  lava pool) with positions + metadata. Powers `knownLocationsNearby`.

Corrupt files are backed up (`*.corrupt.*.bak`) and treated as empty rather
than crashing the agent. Set `MEMORY_DIR` to override the storage location
(used by tests for isolation).

## Safety model

The LLM may: reason, create goals/plans/memories, propose declarative skills,
select trusted primitives, reflect. It NEVER receives: shell execution,
filesystem access, `eval`/`Function`, dynamic module loading, arbitrary HTTP,
Paper console, env vars, the OpenRouter key, or raw Mineflayer objects.
Every model-controlled invocation passes `validatePrimitiveCall` /
`validateSkill` / `validatePlannerOutput` / `validateReflection`. OpenRouter
access is isolated in `src/llm/openrouter.js`. Only `fetch()` to OpenRouter
exists; no other network calls.

## Runtime data & logs

- `data/*.json` — memory + skill stores (git-ignored, survive restarts).
- `logs/decisions.jsonl` — decision/event stream (`goal_changed`, `plan`,
  `step`, `reflection`, `interrupt`, `death`, `skill_created`, …) for the
  future Twitch overlay (health, food, goal, plan, thought, reflection,
  skills, deaths, model, tokens).
- In-memory `src/telemetry/metrics.js` counters: steps, deaths, LLM
  calls/errors, primitives/skills executed/failed, reflections, memories,
  goal changes, interrupts.

## Future Twitch integration (not implemented)

```
Mineflayer Agent
      │
      ├── Prismarine Viewer
      │       │
      │       ▼
      │   POV renderer
      │
      └── telemetry
              │
              ▼
        stream overlay
              │
              ▼
             OBS
              │
              ▼
            Twitch
```

The VM stays fully headless; `logs/decisions.jsonl` + metrics already expose
everything an overlay needs (goal, plan, thought, action, reflection,
memories, skills, health, food, deaths, model, tokens).

## Benchmark mode (regression test)

```bash
AGENT_MODE=benchmark AGENT_GOAL="Collect 8 logs without dying." npm start
```

Legacy allowlist (`observe`, `collect_logs`, `chat`, `wait`, `finish`) via
`src/safety/validator.js`, bounded by `MAX_AGENT_STEPS` (defaults to 30 when
`0`). Proves the Mineflayer integration still works after refactors.
