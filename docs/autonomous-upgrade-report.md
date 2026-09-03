# Autonomous Upgrade Report

Autonomous agent evolution complete. All 67 tests pass, no live server needed.

## 1. What architecture changed

Sense → single-action → act became a full cognition cycle in
`src/agent/loop.js` (`runAutonomousLoop`): bounded perception →
deterministic interrupts → top-k memory retrieval → LLM gating → rich
planning → one validated step → outcome → reflection → memory → replan.
Benchmark loop preserved separately (`AGENT_MODE=benchmark`).

New modules: `bot/perception.js`, `bot/interrupts.js`, `primitives/`
(8 files + registry), `agent/{cognition,context,goals,reflection}.js`,
`skills/{executor,generator,library,scorer}.js`,
`memory/{store,semantic,episodic,procedural,world,retrieval}.js`,
`safety/{primitiveValidator,skillValidator}.js`,
`telemetry/decisions.js`. Old v1 modules retained for benchmark, legacy
memory files marked deprecated.

## 2. Major new capabilities

Self-chosen goals with suspension on danger, 20 trusted primitives, JSON
skill creation/scoring/revision, 4 persistent memory stores with retrieval,
validated reflection after death/combat/failures/discoveries, interrupt
preemption, planner circuit-breaker + backoff, death/respawn without
duplicate loops, `decisions.jsonl` event stream.

## 3. Final repository tree

```
src/
  index.js
  bot/{createBot,events,observations,perception,interrupts}.js
  agent/{loop,cognition,planner,prompts,context,goals,reflection,actions}.js
  llm/openrouter.js
  primitives/{index,movement,perception,combat,mining,crafting,
    inventory,interaction,survival}.js
  skills/{executor,generator,library,scorer,
    movement,collectLogs,mining,crafting}.js
  memory/{store,semantic,episodic,procedural,world,retrieval,
    memory*,locations*}.js   (* = deprecated, benchmark compat)
  safety/{validator,primitiveValidator,skillValidator,limits}.js
  telemetry/{logger,metrics,decisions}.js
tests/ (11 files)
docs/{architecture,roadmap,autonomous-upgrade-report}.md (this file)
```

## 4. Memory architecture

JSON in `data/` (`MEMORY_DIR`-overridable):

- `semantic.json` — facts + confidence, deduped, pruned
  (e.g. creepers explode; stone pickaxes don't yield diamond)
- `episodic.json` — experiences with context + lesson
  (deaths, fights, discoveries)
- `procedural.json` — per-skill success/failure records
- `world.json` — named locations with positions + metadata
  (shelter, mine, diamond vein, lava pool)

Atomic tmp+rename writes; corrupt files backed up (`*.corrupt.*.bak`) and
treated as empty; all stores bounded by env config; survive restarts.

## 5. Skill architecture

LLM proposes pure-JSON `{id,name,description,parameters,steps[]}` →
`skillValidator` (rejects unknown primitives, bad args, unknown `$refs`,
>12 steps, code/shell/path/URL/env/loop/recursion) → `library.js`
(`data/skills.json`, versioned, score-ranked, lowest-score eviction) →
`executor.js` (ordered, `$param` substitution, fail-fast, timeouts,
interrupt abortion, health/food/inventory deltas) → `scorer.js`
(+ procedural memory sync). Skills are DATA — never generated JavaScript,
never `eval`'d.

## 6. Primitive list

- Movement: `move_near`, `move_near_entity`, `move_away_from_entity`,
  `stop_movement`
- Perception: `find_block`, `find_entity`
- Combat: `equip_best_melee_weapon`, `attack_entity`
  (chase 32 / duration 20s caps), `stop_attacking`
- Inventory: `equip_item`, `inspect_inventory`
- Survival: `eat_best_food`, `sleep`, `wait`
- Mining: `mine_block`, `mine_block_type`
  (reports `blockBroken`/`dropObtained` for tool-tier learning)
- Crafting: `craft_item`
- Interaction: `place_block`, `use_item`, `chat`

## 7. Safety boundaries

Verified by grep: no `eval` / `Function` / `child_process` / shell anywhere;
`process.env` only in trusted config modules. The LLM receives compact JSON
only — no Mineflayer objects, files, env vars, keys, or console. Every
model-controlled invocation passes `validatePrimitiveCall` /
`validateSkill` / `validatePlannerOutput` / `validateReflection`. The only
network call is `fetch` to OpenRouter in `src/llm/openrouter.js`.

## 8. Tests added

- `primitives.test.js` (10) — valid/unknown/invalid/dangerous calls,
  validate-before-touch, mock-bot execution
- `skills.test.js` (10) — skill validation cases, ordered execution,
  param substitution, fail-fast, interrupt abort, generator parsing
- `memory.test.js` (7) — persistence, dedup, bounds, malformed files
- `retrieval.test.js` (4) — creeper/diamond/night contexts, exclusion
- `goals.test.js` (4) — creation, replacement, suspension, completion
- `reflection.test.js` (5) — valid/malformed/forbidden proposals, triggers
- `interrupts.test.js` (5) — health/hostile/fire/death/hunger thresholds
- `cognition.test.js` (8) — plan validation, gating, context bounds,
  no-duplicate-loop guard, benchmark completion
- `perception.test.js` (4) — rich fields, legacy compat, time categories
- Plus 3 pre-existing files untouched and passing

## 9. Test results

- `npm test`: **67 pass, 0 fail**
- `npm run check`: OK
- Module-load check (13 modules, no circular-dependency issues): OK

## 10. Live testing performed

No live server or OpenRouter key in this environment, so no real
integration is claimed. Instead:

- Benchmark completion verified with a mock bot (8 logs → `completed`,
  no LLM call).
- Autonomous smoke run verified with a mock bot and no key
  (`MAX_AGENT_STEPS=2` → planner fails gracefully → safe fallback
  → `budget_exhausted`, no crash).

## 11. Limitations

- No live Mineflayer/OpenRouter run yet.
- Combat uses `bot.attack` (no pvp plugin).
- No shelter-building skill seeds, no death-item recovery, no
  overlay/viewer (telemetry is ready for them).
- `MAX_AGENT_STEPS=0` now means unlimited — set an explicit bound for
  test runs.

## 12. Commands to run after pulling onto the Ubuntu VM

```bash
cd ~/minecraft-lab/ai-plays-minecraft
git pull
npm install
npm test          # expect 67 pass
npm run check     # expect OK
cp .env.example .env   # if needed; set OPENROUTER_API_KEY
# benchmark regression:
AGENT_MODE=benchmark MAX_AGENT_STEPS=30 npm start
# autonomous:
AGENT_MODE=autonomous MAX_AGENT_STEPS=0 npm start
```

## 13. Recommended first autonomous experiment

Fresh survival world, `AGENT_MODE=autonomous`, `MAX_AGENT_STEPS=0`,
`DECISION_DELAY_MS=1000`, memory/reflection/skills enabled; run 30–60
minutes; keep `data/` between deaths; then inspect
`logs/decisions.jsonl` for goal changes, reflections, and created skills —
look for shelter-before-night, eating, retreat, and wood → stone → iron
progression emerging rather than scripted.
