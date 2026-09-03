# Architecture

Autonomous headless Minecraft AI agent: a Mineflayer bot connects to a local
Paper 1.21.11 server; an OpenRouter LLM performs cognition (goals, plans,
declarative skills, reflection); trusted deterministic JS primitives execute
Minecraft mechanics. Benchmark mode (collect 8 logs) is preserved as a
deterministic regression test.

## Cognition loop (autonomous)

```
Minecraft
  ↓
Perception (bounded, cached, throttled block scans)
  ↓
Memory Retrieval (deterministic keyword/entity matching, top-k per store)
  ↓
Cognition (should we call the LLM at all?)
  ↓
Goals + Planning (rich planning object, strictly validated)
  ↓
Validated Skill/Primitive (allowlisted, schema-checked, timeouts)
  ↓
Mineflayer (trusted code only — the model never touches it)
  ↓
Outcome (structured { ok, ... } with failure detail preserved)
  ↓
Reflection (LLM, validated; suggests memories/goals/skill revisions)
  ↓
Memory (semantic / episodic / procedural / world, JSON, bounded)
  ↓
(replan — normally one meaningful nextStep per tick, then re-observe)
```

Plans are intentions, not scripts: only `nextStep` executes per tick, then
the agent re-observes. Routine deterministic progress (path execution,
in-skill waits) does not trigger LLM calls. Interrupts (deterministic
thresholds: critical health/hunger, immediate threat, fire, death) preempt
skills via cooperative abortion, suspend the current goal, and force
emergency replanning.

## Trust boundary

Two execution levels:

- **Level 1 — trusted Minecraft primitives** (`src/primitives/`,
  implemented by us in JavaScript): fixed names, fixed argument schemas
  (`src/safety/primitiveValidator.js`), validation, timeouts, bounded
  behavior, structured results. The LLM cannot invent new primitives.
- **Level 2 — LLM-created declarative skills** (`src/skills/`, pure JSON
  data): ordered lists of `{ primitive, args }` with `$param` substitution,
  validated by `src/safety/skillValidator.js` before storage or execution.
  No JavaScript, no `eval`, no shell, no paths, no URLs, no env, no loops,
  no recursion, no nested execution. Max 12 steps.

The LLM may reason, choose goals, plan, propose skills, write memories, and
reflect. It may NOT: run shell/JS, touch files, `eval`/`Function`, dynamic
`require`, arbitrary HTTP, Paper console, env vars, API keys, or arbitrary
Mineflayer methods. Every model-controlled invocation passes validation.
OpenRouter access is isolated in `src/llm/openrouter.js` (the only `fetch`).
No code execution, no database, no vector DB, no agent harness — the
domain-specific loop, memory, tool boundary, and executor live in this repo
(kept modular so an external harness could theoretically integrate later).

## Module map

- `src/bot/` — `createBot.js` (connection + pathfinder/collectblock),
  `events.js` (login/spawn/health/death/kick logging), `observations.js`
  (rich bounded perception), `perception.js` (cache facade),
  `interrupts.js` (deterministic thresholds).
- `src/primitives/` — `movement|perception|combat|mining|crafting|`
  `inventory|interaction|survival.js` + `index.js` registry
  (validate → dispatch with timeout).
- `src/agent/` — `loop.js` (benchmark + autonomous loops), `cognition.js`
  (plan validation + LLM gating), `planner.js` (OpenRouter planning),
  `prompts.js` (autonomous + benchmark prompts), `context.js` (compact
  bounded context), `goals.js` (directive/current/subgoals/suspended),
  `reflection.js` (structured lessons), `actions.js` (benchmark dispatch +
  autonomous `executeNextStep`).
- `src/skills/` — `validator` via `src/safety/skillValidator.js`,
  `library.js` (JSON persistence + scoring fields), `executor.js`
  (ordered, fail-fast, interruptible), `scorer.js` (success/failure +
  ranking), `generator.js` (proposal prompt + parsing). Legacy
  `movement|collectLogs|mining|crafting.js` retained for benchmark mode.
- `src/memory/` — `semantic|episodic|procedural|world.js` (JSON stores),
  `retrieval.js` (deterministic top-k), `store.js` (atomic-ish writes,
  corrupt-file backup). Legacy `memory|locations.js` retained (deprecated).
- `src/llm/openrouter.js` — sole OpenRouter caller.
- `src/safety/` — `validator.js` (benchmark allowlist, retained),
  `primitiveValidator.js` (canonical schemas), `skillValidator.js`
  (declarative skill checks), `limits.js` (all env config; `MAX_AGENT_STEPS=0`
  = unlimited).
- `src/telemetry/` — `logger.js`, `metrics.js` (counters), `decisions.js`
  (JSONL event stream for the future overlay).
- `src/index.js` — mode dispatch (`AGENT_MODE`), single-loop guard
  (no duplicate loops after respawn), clean shutdown.

## Safety properties

- Long-run resilience: planner failures back off with a circuit breaker
  (pause + retry, never kill the server); memory/skill writes are bounded
  and corrupt-tolerant; telemetry never throws; death increments metrics,
  stores an episode, reflects on respawn, and resumes without a second loop.
- Knowledge philosophy: no wiki database is preloaded. Deterministic facts
  exist only where APIs/mechanics require them; lessons (creeper blasts,
  tool tiers, retreat timing) are learned from objective primitive results
  via reflection into memory.
