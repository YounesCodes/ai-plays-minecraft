# Roadmap

## v1 (done): collect 8 logs without dying

- Offline-auth Mineflayer bot on `127.0.0.1:25565`, Paper 1.21.11.
- Sense–plan–act loop with strict action allowlist.
- Skills: `moveNear`, `collectLogs`, `mineBlockType`, `craftItem` scaffold.
- Telemetry: timestamped logs + counters (steps, deaths, logs, LLM calls).
- Preserved as `AGENT_MODE=benchmark` regression test.

## v2 (implemented in this update): autonomous survival agent

- [x] Rich bounded perception (health/food/armor, equipment + durability,
      position, dimension, fire/underwater, time + day/night, weather, light,
      bounded inventory, hostile/passive entities, interesting blocks, known
      locations; throttled + cached block scans).
- [x] 20 trusted primitives across movement/perception/combat/mining/
      crafting/inventory/interaction/survival with schemas, validation,
      timeouts, structured results (incl. `blockBroken`/`dropObtained` for
      tool-tier learning).
- [x] Autonomous goal manager (directive + current + subgoals + suspended +
      history); LLM may create/replace/suspend goals.
- [x] Four JSON memory stores (semantic/episodic/procedural/world) with IDs,
      timestamps, confidence, dedup, bounds, pruning, atomic-ish writes,
      corrupt-file tolerance; survive restarts.
- [x] Deterministic top-k memory retrieval (keyword/entity signals; no
      embeddings).
- [x] Reflection subsystem (validated; suggests memories/goals/skill
      revisions; triggers: death, damage, combat, failures, discoveries,
      milestones).
- [x] Declarative JSON skills (validator + library + executor + scorer +
      generator; max 12 steps; interruptible; success/failure tracking).
- [x] Rich planning output (assessment + goal + plan + nextStep +
      proposeSkill + memoryToCreate); one-step execution + re-observe.
- [x] Deterministic interrupts (critical health/hunger, immediate threat,
      fire, death, …) with goal suspension + emergency replanning.
- [x] Bounded combat support (approach/attack/retreat/stop, chase + duration
      caps); strategy left to the LLM + learned memory.
- [x] Cognition loop with LLM gating, planner circuit breaker + backoff,
      death/respawn handling without duplicate loops.
- [x] Expanded telemetry (`logs/decisions.jsonl` event stream + counters)
      ready for a future overlay; no secrets logged.
- [x] 67 unit tests, no server/network/key required.
- [x] Docs (README, architecture, roadmap) match implementation.

## Next (not started)

1. Live tuning: 30–60 min autonomous survival runs; observe whether basic
   survival patterns (shelter before night, eating, retreat, tool
   progression wood → stone → iron) emerge from reflection + memory.
2. Item recovery after death (return to death location when safe).
3. Hut/shelter-building skill seeds and bed/respawn management.
4. Sapling replanting + tree-location reuse from world memory.
5. Log rotation + systemd hardening + Paper backup hooks.
6. Later (out of scope): Prismarine Viewer POV, stream overlay → OBS →
   Twitch, web dashboard, multi-agent.

## Non-goals

Docker, TypeScript, databases, Redis, vector DBs, general-purpose agent
harnesses (LangChain/CrewAI/AutoGen/Hermes), Twitch/Prismarine Viewer
implementation in this task, arbitrary code execution by the LLM.
