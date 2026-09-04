'use strict';

// Main agent loops.
// - Benchmark: legacy sense->plan->validate->act, goal = collect 8 logs.
// - Autonomous: perception -> interrupts -> memory retrieval -> cognition ->
//   validated primitive/skill -> outcome -> reflection -> memory -> replan.

const { plan, planAutonomous } = require('./planner');
const { executeAction, executeNextStep } = require('./actions');
const { observe } = require('../bot/observations');
const { createPerceptionCache } = require('../bot/perception');
const { detectInterrupts, isUrgent } = require('../bot/interrupts');
const { validateAction } = require('../safety/validator');
const { getLimits, countLogsInInventory, isGoalComplete } = require('../safety/limits');
const { createGoalManager } = require('./goals');
const { buildContext } = require('./context');
const { needsPlanner } = require('./cognition');
const { categorizePlannerError } = require('./cognition');
const targetFailures = require('../navigation/targetFailures');
const explorationState = require('../navigation/exploration');
const { FOOD_PRIORITY } = require('../primitives/survival');
const { retrieveRelevant } = require('../memory/retrieval');
const { buildReflectionPrompt, parseReflectionResponse, shouldReflect } = require('./reflection');
const { complete } = require('../llm/openrouter');
const { logger } = require('../telemetry/logger');
const metrics = require('../telemetry/metrics');
const decisions = require('../telemetry/decisions');
const skillLibrary = require('../skills/library');
const { scoreSkillOutcome } = require('../skills/scorer');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeAction(a) {
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

function memoryEnabled() {
  return process.env.MEMORY_ENABLED !== 'false' && process.env.MEMORY_ENABLED !== '0';
}

function reflectionEnabled() {
  return process.env.REFLECTION_ENABLED !== 'false' && process.env.REFLECTION_ENABLED !== '0';
}

function skillGenEnabled() {
  return process.env.SKILL_GENERATION_ENABLED !== 'false' && process.env.SKILL_GENERATION_ENABLED !== '0';
}

function loadStores() {
  if (!memoryEnabled()) return { semantic: [], episodic: [], procedural: [], world: [] };
  try {
    return {
      semantic: require('../memory/semantic').list(),
      episodic: require('../memory/episodic').list(),
      procedural: require('../memory/procedural').list(),
      world: require('../memory/world').list(),
    };
  } catch {
    return { semantic: [], episodic: [], procedural: [], world: [] };
  }
}

function writeSemanticMemory(payload) {
  try {
    return require('../memory/semantic').add(payload);
  } catch (err) {
    return { ok: false, error: err?.message || 'memory write failed' };
  }
}

function writeEpisodicMemory(payload) {
  try {
    return require('../memory/episodic').add(payload);
  } catch (err) {
    return { ok: false, error: err?.message || 'memory write failed' };
  }
}

async function runAgentLoop(bot, options = {}) {
  if (bot.__agentLoopRunning) {
    logger.warn('Agent loop already running; refusing to start a duplicate.');
    return { status: 'already_running' };
  }
  const limits = getLimits();
  const mode = (options.mode || limits.agentMode || 'autonomous').toLowerCase();
  if (mode === 'benchmark') {
    return runBenchmarkLoop(bot, options);
  }
  return runAutonomousLoop(bot, options);
}

// ---------------------------------------------------------------------------
// Benchmark mode (deterministic regression test, preserved).
// ---------------------------------------------------------------------------
async function runBenchmarkLoop(bot, options = {}) {
  bot.__agentLoopRunning = true;
  try {
    const limits = getLimits();
    const goal = options.goal || process.env.AGENT_GOAL || 'Collect 8 logs without dying.';
    const maxSteps = options.maxSteps ?? limits.maxSteps ?? 30;
    const delayMs = options.decisionDelayMs ?? limits.decisionDelayMs;
    const bounded = maxSteps === 0 ? 30 : maxSteps;

    logger.info(`Benchmark loop started. Goal: ${goal} (maxSteps=${bounded})`);
    decisions.record('loop_started', { mode: 'benchmark', goal, maxSteps: bounded });

    let lastResult = null;
    let steps = 0;
    let wasDead = false; // count/record each death once, not every tick while dead

    for (let step = 1; step <= bounded; step++) {
      steps = step;
      metrics.inc('steps');

      let state;
      try {
        state = observe(bot);
      } catch (err) {
        logger.error(`Step ${step}: observation failed: ${err?.message || err}`);
        await sleep(delayMs);
        continue;
      }

      if (isGoalComplete(state.inventory)) {
        logger.info(`Goal complete after ${step - 1} steps: ${countLogsInInventory(state.inventory)} logs.`);
        decisions.record('goal_completed', { mode: 'benchmark', logs: countLogsInInventory(state.inventory) });
        return { status: 'completed', steps: step - 1, logs: countLogsInInventory(state.inventory) };
      }

      if (state.health <= 0) {
        if (!wasDead) {
          wasDead = true;
          logger.warn(`Step ${step}: bot is dead; waiting for respawn.`);
          metrics.inc('deaths');
          decisions.record('death', { step, mode: 'benchmark', position: state.position || null });
        }
        lastResult = { ok: false, error: 'Bot is dead' };
        await sleep(delayMs);
        continue;
      }
      wasDead = false; // survived this tick: re-arm death counting

      let rawAction;
      try {
        rawAction = await plan({ goal, state, lastResult });
      } catch (err) {
        logger.error(`Step ${step}: planner failed: ${err?.message || err}`);
        metrics.inc('actionErrors');
        lastResult = { ok: false, error: `Planner error: ${err?.message || err}` };
        await sleep(delayMs);
        continue;
      }

      const check = validateAction(rawAction);
      if (!check.ok) {
        logger.warn(`Step ${step}: rejected invalid action ${describeAction(rawAction)}: ${check.error}`);
        metrics.inc('actionErrors');
        lastResult = { ok: false, error: check.error };
        await sleep(delayMs);
        continue;
      }

      logger.info(`Step ${step}/${bounded}: action=${describeAction(check.value)}`);
      let result;
      try {
        result = await executeAction(bot, check.value);
      } catch (err) {
        logger.error(`Step ${step}: action crashed: ${err?.message || err}`);
        metrics.inc('actionErrors');
        result = { ok: false, error: err?.message || 'Action failed' };
      }
      logger.info(`Step ${step} result: ${describeAction(result)}`);
      decisions.record('benchmark_step', { step, action: check.value, ok: !!result?.ok });
      lastResult = result;

      if (result && result.done) {
        logger.info(`Finished by LLM: ${result.reason || ''}`);
        return { status: 'finished', steps: step, reason: result.reason || '' };
      }

      if (result && typeof result.collected === 'number') {
        metrics.inc('logsCollected', Math.max(0, result.collected - 0));
      }

      try {
        const after = observe(bot);
        if (isGoalComplete(after.inventory)) {
          logger.info(`Goal complete after step ${step}: ${countLogsInInventory(after.inventory)} logs.`);
          return { status: 'completed', steps: step, logs: countLogsInInventory(after.inventory) };
        }
      } catch {
        // ignore; next iteration re-observes
      }

      await sleep(delayMs);
    }

    logger.info(`Step budget exhausted (${bounded} steps).`);
    return { status: 'budget_exhausted', steps };
  } finally {
    bot.__agentLoopRunning = false;
  }
}

// ---------------------------------------------------------------------------
// Autonomous mode.
// ---------------------------------------------------------------------------
async function runAutonomousLoop(bot, options = {}) {
  bot.__agentLoopRunning = true;
  try {
    const limits = getLimits();
    const directive = options.directive || limits.agentDirective;
    const maxSteps = options.maxSteps ?? limits.maxSteps ?? 0; // 0 = unlimited
    const delayMs = options.decisionDelayMs ?? limits.decisionDelayMs;
    const maxPlannerFailures = limits.maxConsecutivePlannerFailures;
    const backoffBase = limits.plannerBackoffBaseMs;

    const goalManager = createGoalManager({ directive });
    goalManager.setGoal('Survive the first day: gather wood, find food, and seek shelter before night', {
      priority: 60,
      reason: 'Default early-survival goal until the planner decides otherwise',
      subgoals: ['collect wood', 'find food', 'assess surroundings'],
    });

    const cache = createPerceptionCache();
    const worldMemory = memoryEnabled() ? require('../memory/world') : null;
    let activePlan = [];
    let recentEvents = [];
    let recentFailures = [];
    let lastResult = null;
    let ticksSincePlan = 99;
    let consecutiveFailures = 0;
    let consecutivePlannerFailures = 0;
    let wasDead = false;
    let abortRequested = null;
    let calmStreak = 0; // consecutive ticks with no interrupt (drives goal resume)
    let resourceFailStreak = 0; // consecutive resource-search failures (drives exploration)
    const recentDeaths = []; // { at, position } for relocation signals
    let step = 0;
    const seenValuables = new Set();
    const milestoneItems = new Set();
    let healthBefore = null;

    const pushEvent = (e) => {
      recentEvents.push({ at: new Date().toISOString(), ...e });
      if (recentEvents.length > 20) recentEvents = recentEvents.slice(-20);
    };

    // Damage listener for skill abortion + interrupt signalling.
    const onHealth = () => {
      try {
        if (healthBefore !== null && typeof bot.health === 'number' && bot.health < healthBefore - 2) {
          abortRequested = { type: 'unexpected_damage', priority: 90, reason: `Took damage (${healthBefore} -> ${bot.health})` };
        }
        healthBefore = typeof bot.health === 'number' ? bot.health : healthBefore;
      } catch {
        // ignore
      }
    };
    try {
      bot.on('health', onHealth);
    } catch {
      // mock bots may not support .on
    }

    logger.info(`Autonomous loop started. Directive: ${directive} (maxSteps=${maxSteps === 0 ? 'unlimited' : maxSteps})`);
    decisions.record('loop_started', { mode: 'autonomous', directive: directive.slice(0, 300), maxSteps });

    for (;;) {
      step += 1;
      if (maxSteps !== 0 && step > maxSteps) {
        logger.info(`Step budget exhausted (${maxSteps} steps).`);
        decisions.record('budget_exhausted', { steps: step - 1 });
        return { status: 'budget_exhausted', steps: step - 1 };
      }
      metrics.inc('steps');

      // 1. Bounded perception.
      let perception;
      try {
        perception = observe(bot, { cache, worldMemory });
      } catch (err) {
        logger.error(`Step ${step}: observation failed: ${err?.message || err}`);
        await sleep(delayMs);
        continue;
      }
      if (healthBefore === null && typeof perception.health === 'number') healthBefore = perception.health;
      try {
        const pp = perception.position || (perception.self && perception.self.position);
        if (pp && Number.isFinite(pp.x) && Number.isFinite(pp.z)) explorationState.recordVisit(pp.x, pp.z);
      } catch {
        // telemetry must never break the loop
      }

      // Death / respawn handling.
      if (perception.health <= 0 || perception.self?.health <= 0) {
        if (!wasDead) {
          wasDead = true;
          metrics.inc('deaths');
          pushEvent({ type: 'death', step, position: perception.position });
          decisions.record('death', { step, position: perception.position });
          try {
            recentDeaths.push({ at: Date.now(), position: perception.position || null });
            while (recentDeaths.length > 20) recentDeaths.shift();
          } catch {
            // ignore
          }
          logger.warn(`Step ${step}: died. Waiting for respawn.`);
          if (memoryEnabled()) {
            writeEpisodicMemory({
              summary: `Died at step ${step}.`,
              context: { health: 0, position: perception.position },
              lesson: 'Avoid the situation that led to this death.',
            });
          }
        }
        lastResult = { ok: false, error: 'Bot is dead' };
        await sleep(delayMs);
        continue;
      }
      if (wasDead) {
        wasDead = false;
        logger.info(`Step ${step}: respawned. Resuming cognition.`);
        try {
          targetFailures.clear(); // fresh body, fresh place: forget unreachable targets
        } catch {
          // ignore
        }
        decisions.record('respawned', { step, position: perception.position });
        pushEvent({ type: 'respawn', step });
        // Death reflection (best effort, non-fatal).
        await tryReflect({
          event: { type: 'death', death: true },
          goal: goalManager.getState().currentGoal,
          stateBefore: null,
          attempted: lastResult,
          result: { ok: false, error: 'death' },
          stateAfter: perception,
          goalManager,
          step,
        });
        await sleep(delayMs);
        continue;
      }

      // 2. Interrupt detection (deterministic).
      let interrupts = [];
      try {
        const extra = {};
        if (abortRequested) extra.damageTaken = 6;
        interrupts = detectInterrupts(perception, extra);
      } catch {
        interrupts = [];
      }
      const topInterrupt = interrupts[0] || abortRequested || null;
      if (topInterrupt) {
        metrics.inc('interrupts');
        decisions.record('interrupt', { step, interrupt: topInterrupt });
        if (isUrgent(topInterrupt) && goalManager.getState().currentGoal?.description !== emergencyGoalFor(topInterrupt)) {
          const desc = emergencyGoalFor(topInterrupt);
          if (desc) {
            const prev = goalManager.getState().currentGoal?.description || null;
            goalManager.suspendFor(desc, { priority: topInterrupt.priority, reason: topInterrupt.reason || topInterrupt.type });
            metrics.inc('goalChanges');
            decisions.record('goal_changed', { from: prev, to: desc, reason: topInterrupt.reason || topInterrupt.type });
          }
        }
        pushEvent({ type: `interrupt:${topInterrupt.type}`, step, detail: topInterrupt.reason || '' });
      }
      // No active interrupt: an emergency goal that outlived its threat can
      // resume the suspended goal it preempted. Hysteresis (3 calm ticks)
      // avoids suspend/resume flapping when a threat flickers at the edge.
      if (!topInterrupt) {
        calmStreak += 1;
        const gs = goalManager.getState();
        if (calmStreak >= 3 && gs.currentGoal && gs.currentGoal.emergency && gs.suspendedGoal) {
          const from = gs.currentGoal.description;
          const resumed = goalManager.completeGoal('threat cleared; resuming previous goal');
          if (resumed && resumed.ok) {
            calmStreak = 0;
            metrics.inc('goalChanges');
            decisions.record('goal_changed', { from, to: resumed.current ? resumed.current.description : null, reason: 'threat cleared', step });
            logger.info(`Resumed suspended goal: ${resumed.current ? resumed.current.description : '(none)'}`);
          }
        }
      } else {
        calmStreak = 0;
      }

      // 3. Memory retrieval (bounded, deterministic).
      const stores = loadStores();
      let relevant = { semantic: [], episodic: [], procedural: [], world: [] };
      try {
        const { retrieveRelevant: retrieve } = require('../memory/retrieval');
        relevant = retrieve({
          goal: goalManager.getState().currentGoal,
          perception,
          recentFailures,
          stores,
        });
      } catch {
        relevant = { semantic: [], episodic: [], procedural: [], world: [] };
      }

      // 4-5. Decide whether an LLM call is required.
      const significantEvent = inferSignificantEvent(lastResult, perception, seenValuables, milestoneItems);
      if (significantEvent) pushEvent({ type: significantEvent.type, step });
      const gate = needsPlanner({
        interrupt: topInterrupt && isUrgent(topInterrupt) ? topInterrupt : null,
        goalState: goalManager.getState(),
        lastResult,
        ticksSincePlan,
        consecutiveFailures,
        significantEvent,
      });

      // Known skills for validation + prompt.
      let knownSkills = [];
      try {
        knownSkills = skillLibrary.list();
      } catch {
        knownSkills = [];
      }
      const knownSkillNames = knownSkills.map((s) => s.name).concat(knownSkills.map((s) => s.id));

      let freshPlan = null;
      if (gate.needed) {
        const context = buildContext({
          directive,
          goalState: goalManager.getState(),
          perception,
          activePlan,
          lastResult,
          recentEvents,
          relevantMemories: relevant,
          availableSkills: rankRelevantSkills(knownSkills, relevant),
          exploration: explorationSummary(perception, resourceFailStreak),
          deathSignal: deathSignalFor(recentDeaths),
        });
        try {
          const { plan: validated } = await planAutonomous({ context, knownSkillNames });
          freshPlan = validated;
          consecutivePlannerFailures = 0;
          ticksSincePlan = 0;
          applyPlannerSideEffects({ validated, goalManager, step, perception });
          activePlan = Array.isArray(validated.plan) ? [...validated.plan] : [];
          // The prompt example shows nextStep duplicated as plan[0]; executing
          // nextStep now and shifting plan[0] later would run it twice.
          if (activePlan.length > 0 && sameStep(activePlan[0], freshPlan.nextStep)) {
            activePlan.shift();
            logger.debug('Dropped plan[0] duplicate of nextStep.');
          }
          decisions.record('plan', {
            step,
            assessment: validated.assessment?.summary?.slice(0, 300),
            goal: validated.goal?.description,
            nextStep: validated.nextStep,
            proposeSkill: validated.proposeSkill ? validated.proposeSkill.id : null,
          });
        } catch (err) {
          consecutivePlannerFailures += 1;
          metrics.inc('llmErrors');
          logger.error(`Step ${step}: autonomous planner failed (${consecutivePlannerFailures}/${maxPlannerFailures}): ${err?.message || err}`);
          decisions.record('planner_failed', { step, error: String(err?.message || err).slice(0, 300), consecutive: consecutivePlannerFailures, category: categorizePlannerError(err), model: process.env.OPENROUTER_MODEL || null });
          if (consecutivePlannerFailures >= maxPlannerFailures) {
            logger.warn(`Circuit breaker: pausing planning after ${consecutivePlannerFailures} consecutive failures.`);
            decisions.record('circuit_breaker', { step, consecutive: consecutivePlannerFailures });
            await sleep(Math.min(60000, backoffBase * 4));
            consecutivePlannerFailures = 0;
            await sleep(delayMs);
            continue;
          }
          await sleep(Math.min(30000, backoffBase * Math.pow(2, consecutivePlannerFailures - 1)));
          // Deterministic safe fallback (no LLM): eat if hungry, else wait.
          lastResult = await safeFallback(bot, perception, topInterrupt);
          ticksSincePlan += 1;
          await sleep(delayMs);
          continue;
        }
      } else {
        ticksSincePlan += 1;
      }

      // 6. Resolve one meaningful step.
      let nextStep = null;
      if (freshPlan) {
        nextStep = freshPlan.nextStep;
      } else if (activePlan.length > 0) {
        nextStep = activePlan.shift();
      } else {
        // No plan queued: force a planning tick next iteration.
        ticksSincePlan = 99;
        await sleep(delayMs);
        continue;
      }

      // 7. Execute with validation inside executeNextStep.
      const stateBefore = summarizeForReflection(perception);
      let result;
      const isSkillStep = nextStep.type === 'skill';
      try {
        abortRequested = null;
        result = await executeNextStep(bot, nextStep, {
          timeoutMs: limits.primitiveTimeoutMs,
          shouldAbort: () => {
            if (abortRequested) return abortRequested;
            return null;
          },
        });
        metrics.inc('primitivesExecuted');
        if (isSkillStep) {
          metrics.inc('skillsExecuted');
          if (!result?.ok) metrics.inc('skillFailures');
        }
        if (!result?.ok && nextStep.type === 'primitive') metrics.inc('primitiveErrors');
      } catch (err) {
        result = { ok: false, error: err?.message || 'Step crashed' };
        metrics.inc('actionErrors');
      }
      logger.info(`Step ${step} ${nextStep.type}:${nextStep.name} -> ${describeAction(result)}`);
      decisions.record('step', { step, nextStep, ok: !!result?.ok, error: result?.error || null });

      // Skill scoring.
      if (isSkillStep) {
        try {
          const skill = skillLibrary.get(nextStep.name);
          if (skill) {
            scoreSkillOutcome(skill.id, result);
            metrics.inc('memoriesWritten', 0); // no-op keep counters stable
          }
        } catch {
          // ignore
        }
      }

      // Track failures for retrieval + reflection.
      if (result?.ok) {
        consecutiveFailures = 0;
      } else {
        consecutiveFailures += 1;
        if (result?.error) {
          recentFailures.push(String(result.error).slice(0, 200));
          if (recentFailures.length > 10) recentFailures = recentFailures.slice(-10);
        }
        metrics.inc('actionErrors');
      }
      // Local-search exhaustion signal for exploration decisions: consecutive
      // resource failures (nothing seen / nothing reachable), reset on success.
      if (result && !result.ok && (result.reason === 'no_reachable_target' || result.reason === 'resource_not_seen' || /No .* found within|No .* within/.test(result.error || ''))) {
        resourceFailStreak += 1;
      } else if (result && result.ok) {
        resourceFailStreak = 0;
      }
      lastResult = result;

      // 8. Post-step perception + reflection.
      let perceptionAfter = null;
      try {
        perceptionAfter = observe(bot, { cache, worldMemory });
      } catch {
        perceptionAfter = null;
      }
      const reflectEvent = buildOutcomeEvent({ nextStep, result, perceptionAfter, consecutiveFailures });
      if (reflectEvent && reflectionEnabled() && shouldReflect(reflectEvent)) {
        await tryReflect({
          event: reflectEvent,
          goal: goalManager.getState().currentGoal,
          stateBefore,
          attempted: nextStep,
          result,
          stateAfter: summarizeForReflection(perceptionAfter),
          relevantMemories: relevant,
          goalManager,
          step,
        });
      }

      abortRequested = null;
      await sleep(delayMs);
    }
  } finally {
    bot.__agentLoopRunning = false;
  }
}

function sameStep(a, b) {
  // Deep-equality for plan steps (type + name + args) used to drop a
  // plan[0] that merely repeats the just-executed nextStep.
  try {
    if (!a || !b || a.type !== b.type || a.name !== b.name) return false;
    return JSON.stringify(a.args || {}) === JSON.stringify(b.args || {});
  } catch {
    return false;
  }
}

function explorationSummary(perception, resourceFailStreak) {
  try {
    const p = perception && (perception.position || (perception.self && perception.self.position));
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) return null;
    const s = explorationState.summary(p.x, p.z);
    return { ...s, localSearchExhausted: resourceFailStreak >= 3 };
  } catch {
    return null;
  }
}

function deathSignalFor(recentDeaths) {
  try {
    const now = Date.now();
    const windowMs = 10 * 60 * 1000;
    const recent = (recentDeaths || []).filter((d) => now - d.at < windowMs);
    if (recent.length === 0) return null;
    const cells = {};
    for (const d of recent) {
      const p = d.position || {};
      if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
      const k = explorationState.cellKey(p.x, p.z);
      cells[k] = (cells[k] || 0) + 1;
    }
    let region = null;
    let best = 0;
    for (const [k, n] of Object.entries(cells)) {
      if (n > best) {
        best = n;
        region = k;
      }
    }
    return {
      recentDeaths: recent.length,
      recentDeathRegion: region,
      repeatedFailure: recent.length >= 3
        ? `Died ${recent.length} times recently${region ? ` near sector ${region}` : ''}; consider relocating to a safer bootstrap area`
        : null,
    };
  } catch {
    return null;
  }
}

function emergencyGoalFor(interrupt) {
  switch (interrupt?.type) {
    case 'immediate_threat':
      return `Escape ${interrupt.source || 'threat'} immediately and survive`;
    case 'critical_health':
      return 'Retreat to safety and recover health';
    case 'critical_hunger':
      return 'Find and eat food immediately';
    case 'on_fire':
      return 'Extinguish fire and reach safety';
    default:
      return null;
  }
}

function rankRelevantSkills(skills, relevant) {
  const preferred = new Set((relevant?.procedural || []).map((p) => p.skillId));
  const arr = [...(skills || [])];
  arr.sort((a, b) => {
    const ap = preferred.has(a.id) ? 1 : 0;
    const bp = preferred.has(b.id) ? 1 : 0;
    if (ap !== bp) return bp - ap;
    return (b.score ?? 0.5) - (a.score ?? 0.5);
  });
  return arr.slice(0, 10);
}

function applyPlannerSideEffects({ validated, goalManager, step, perception }) {
  // Goal update: only an explicit changeGoal replaces the current goal.
  // (Previously any description drift replaced it, which thrashed goals.)
  const current = goalManager.getState().currentGoal;
  const incoming = validated.goal || {};
  if (!current || incoming.changeGoal === true) {
    const prev = current?.description || null;
    goalManager.setGoal(incoming.description, {
      priority: incoming.priority,
      reason: incoming.reason,
      subgoals: [],
    });
    metrics.inc('goalChanges');
    decisions.record('goal_changed', { from: prev, to: incoming.description, reason: incoming.reason, step });
  } else {
    logger.debug('Keeping current goal; planner did not set changeGoal.');
  }
  // Proposed skill.
  if (validated.proposeSkill && skillGenEnabled()) {
    try {
      const res = skillLibrary.put(validated.proposeSkill);
      if (res?.ok) {
        metrics.inc('skillsGenerated');
        decisions.record('skill_created', { id: validated.proposeSkill.id, step });
        if (memoryEnabled()) {
          try {
            require('../memory/procedural').upsert({ skillId: validated.proposeSkill.id, description: validated.proposeSkill.description });
          } catch { /* ignore */ }
        }
      } else {
        decisions.record('skill_rejected', { id: validated.proposeSkill?.id || null, error: res?.error || 'invalid', step });
      }
    } catch (err) {
      decisions.record('skill_rejected', { error: err?.message || 'store failed', step });
    }
  }
  // Inline memory proposal.
  if (validated.memoryToCreate && memoryEnabled()) {
    applyMemoryProposal(validated.memoryToCreate, perception, step);
  }
}

function applyMemoryProposal(m, perception, step) {
  try {
    if (m.kind === 'semantic' && m.subject && m.content) {
      const res = writeSemanticMemory({ subject: m.subject, content: m.content, confidence: m.confidence ?? 0.6, source: 'planner' });
      if (res?.ok) {
        metrics.inc('memoriesWritten');
        decisions.record('memory_written', { kind: 'semantic', subject: m.subject, step });
      }
    } else if (m.kind === 'episodic' && (m.summary || m.content)) {
      const res = writeEpisodicMemory({
        summary: m.summary || m.content,
        context: { position: perception?.position || null },
        lesson: m.lesson || '',
      });
      if (res?.ok) {
        metrics.inc('memoriesWritten');
        decisions.record('memory_written', { kind: 'episodic', step });
      }
    } else if (m.kind === 'world' && m.name && m.position) {
      const world = require('../memory/world');
      const res = world.remember(m.name, m.position, m.metadata || {}, perception?.self?.dimension);
      if (res?.ok) {
        metrics.inc('memoriesWritten');
        decisions.record('memory_written', { kind: 'world', name: m.name, step });
      }
    }
  } catch {
    // ignore
  }
}

async function safeFallback(bot, perception, topInterrupt) {
  // No-LLM safe default with survival priorities: flee an immediate hostile
  // first (an invalid planner response must never mean standing still next
  // to a zombie), eat when hungry and food is on hand, else wait briefly.
  // Strategy still belongs to the LLM; this only prevents stupid deaths.
  const { executePrimitive } = require('../primitives');
  const toEntityId = (v) => {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  try {
    const hostileId = (() => {
      try {
        const t = topInterrupt;
        if (t && (t.type === 'immediate_threat' || t.type === 'hostile_nearby')) {
          const fromInterrupt = toEntityId(t.entityId);
          if (fromInterrupt !== null) return fromInterrupt;
        }
        const entities = perception?.nearbyEntitiesDetailed || perception?.nearbyEntities || [];
        let best = null;
        for (const e of entities) {
          if (!e || e.hostile !== true || typeof e.distance !== 'number') continue;
          if (e.distance > 16) continue;
          if (!best || e.distance < best.distance) best = e;
        }
        return best ? toEntityId(best.id ?? best.entityId) : null;
      } catch {
        return null;
      }
    })();
    if (hostileId !== null) {
      const res = await executePrimitive(
        bot,
        { primitive: 'move_away_from_entity', args: { entityId: hostileId, distance: 10 } },
        { timeoutMs: 15000 }
      );
      decisions.record('fallback', { action: 'move_away_from_entity', ok: !!res?.ok });
      return res;
    }
    const food = perception?.self?.food ?? perception?.food ?? 20;
    if (typeof food === 'number' && food <= 14) {
      const names = Object.keys(perception?.inventory || {});
      const foodSet = new Set(FOOD_PRIORITY || []);
      if (names.some((n) => foodSet.has(n))) {
        const res = await executePrimitive(bot, { primitive: 'eat_best_food', args: {} });
        decisions.record('fallback', { action: 'eat_best_food', ok: !!res?.ok });
        return res;
      }
    }
  } catch {
    // fall through to wait
  }
  await sleep(1000);
  return { ok: true, primitive: 'wait', waited: 1, fallback: true };
}

function inferSignificantEvent(lastResult, perception, seenValuables, milestoneItems) {
  try {
    const blocks = perception?.interestingBlocks || [];
    for (const b of blocks) {
      if ((b.type === 'diamond_ore' || b.type === 'deepslate_diamond_ore') && !seenValuables.has('diamond')) {
        seenValuables.add('diamond');
        return { type: 'valuable_discovery', resource: 'diamond' };
      }
    }
    const inv = perception?.inventory || {};
    for (const key of ['iron_pickaxe', 'stone_pickaxe', 'diamond', 'iron_ingot', 'bed']) {
      if (inv[key] > 0 && !milestoneItems.has(key)) {
        milestoneItems.add(key);
        return { type: 'important_item', item: key };
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function buildOutcomeEvent({ nextStep, result, perceptionAfter, consecutiveFailures }) {
  if (!result) return null;
  if (!result.ok && consecutiveFailures >= 3) {
    return { type: 'repeated_failure', consecutiveFailures, lastError: result.error };
  }
  if (!result.ok && nextStep?.type === 'skill') {
    return { type: 'skill_failure', skillFailed: true, skill: nextStep.name, error: result.error };
  }
  if (!result.ok && (nextStep?.name === 'mine_block' || nextStep?.name === 'mine_block_type')) {
    return { type: 'mining_failure', miningFailed: true, error: result.error, block: result.block };
  }
  if (!result.ok && nextStep?.name === 'craft_item') {
    return { type: 'crafting_failure', craftingFailed: true, error: result.error };
  }
  if (result?.ok && nextStep?.name === 'attack_entity' && typeof result.healthChange === 'number' && result.healthChange <= -6) {
    return { type: 'significant_damage', damageTaken: Math.abs(result.healthChange) };
  }
  if (result?.ok && nextStep?.name === 'attack_entity' && result.targetEliminated) {
    return { type: 'combat', combat: true };
  }
  if (!result.ok && nextStep?.name === 'attack_entity') {
    return { type: 'combat', combat: true, error: result.error };
  }
  return null;
}

function summarizeForReflection(perception) {
  if (!perception) return null;
  return {
    health: perception.health,
    food: perception.food,
    position: perception.position,
    inventory: perception.inventory,
    timeCategory: perception.environment?.timeCategory,
  };
}

async function tryReflect({ event, goal, stateBefore, attempted, result, stateAfter, relevantMemories = {}, goalManager, step }) {
  try {
    const prompt = buildReflectionPrompt({ goal, stateBefore, attempted, result, stateAfter, relevantMemories });
    metrics.inc('llmCalls');
    const res = await complete([
      { role: 'system', content: 'You reflect on Minecraft survival experiences. Output exactly one JSON object.' },
      { role: 'user', content: prompt },
    ], { temperature: 0.3 });
    const parsed = parseReflectionResponse(res.content);
    if (!parsed.ok) {
      metrics.inc('llmErrors');
      decisions.record('reflection_failed', { step, error: parsed.error });
      return null;
    }
    const r = parsed.value;
    metrics.inc('reflections');
    decisions.record('reflection', { step, summary: r.summary.slice(0, 300), lesson: (r.lesson || '').slice(0, 300) });
    logger.info(`Reflection: ${r.summary}`);

    if (memoryEnabled()) {
      if (r.storeSemanticMemory && r.semanticMemory) {
        const w = writeSemanticMemory({ ...r.semanticMemory, source: 'reflection' });
        if (w?.ok) metrics.inc('memoriesWritten');
      }
      if (r.storeEpisodicMemory && r.episodicMemory) {
        const w = writeEpisodicMemory({ ...r.episodicMemory, context: { position: stateAfter?.position || null } });
        if (w?.ok) metrics.inc('memoriesWritten');
      }
    }
    if (r.changeGoal && r.suggestedGoal && goalManager) {
      const prev = goalManager.getState().currentGoal?.description || null;
      goalManager.setGoal(r.suggestedGoal, { priority: 70, reason: r.suggestedGoalReason || r.summary });
      metrics.inc('goalChanges');
      decisions.record('goal_changed', { from: prev, to: r.suggestedGoal, reason: 'reflection', step });
    }
    if (r.reviseSkill && skillGenEnabled()) {
      try {
        const { validateSkill } = require('../safety/skillValidator');
        const check = validateSkill(r.reviseSkill);
        if (check.ok) {
          const put = skillLibrary.put(r.reviseSkill);
          if (put?.ok) {
            metrics.inc('skillsGenerated');
            decisions.record('skill_revised', { id: r.reviseSkill.id, step });
          }
        } else {
          decisions.record('skill_rejected', { id: r.reviseSkill?.id || null, error: check.error, step });
        }
      } catch {
        // ignore
      }
    }
    return r;
  } catch (err) {
    metrics.inc('llmErrors');
    decisions.record('reflection_failed', { step, error: String(err?.message || err).slice(0, 300) });
    return null;
  }
}

module.exports = { runAgentLoop, runBenchmarkLoop, runAutonomousLoop, safeFallback };
