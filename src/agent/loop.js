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
const { categorizePlannerError } = require('./cognition');
const { createActionHistory } = require('./actionHistory');
const { createCurriculumManager } = require('../curriculum/manager');
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
    // Stone-age curriculum owns the normal strategic goal (no hard-coded
    // startup goal): the first curriculum tick below sets it from actual
    // inventory/world state, so resumed runs skip satisfied milestones.
    const curriculum = createCurriculumManager();
    const curriculumSession = {};
    let curriculumStarted = false;
    // Readiness-drift tracking (§11): craft milestone with materials ready
    // but repeatedly deferred. Observation only — never auto-executes.
    let readinessDrift = { milestoneId: null, count: 0 };
    let lastTickStatus = null;
    // Description last written BY curriculum sync. A model goalChange to
    // something else is a genuine strategic override and sticks: sync only
    // creates the initial goal or advances its own previous goal, never
    // stomps a model decision the very next tick.
    let lastCurriculumGoal = null;

    const cache = createPerceptionCache();
    const worldMemory = memoryEnabled() ? require('../memory/world') : null;
    const actionHistory = createActionHistory({ max: 10 });
    let recentEvents = [];
    let recentFailures = [];
    let lastResult = null;
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

      // 2b. Curriculum tick (deterministic progression). Skipped while an
      // emergency goal is active — suspension/resume keep working, and the
      // next calm tick re-syncs any stale resumed description.
      let curriculumView = { activeMilestone: null, completedMilestones: [], drift: { detected: false } };
      try {
        const gsNow = goalManager.getState();
        if (!gsNow.currentGoal?.emergency) {
          try {
            const flag = curriculum.noteOutcome(lastResult);
            if (flag) Object.assign(curriculumSession, flag);
          } catch {
            // ignore
          }
          const tickState = curriculum.tick({
            inventory: (perception && perception.inventory) || {},
            nearbyBlocks: (perception && perception.interestingBlocks) || [],
            session: curriculumSession,
            mcVersion: (bot && bot.version) || process.env.MC_VERSION || '1.21.11',
            worldLocations: listWorldLocations(worldMemory),
            botPosition: posOf(perception),
          });
          try {
            lastTickStatus = tickState.activeMilestone && tickState.activeMilestone.status
              ? { id: tickState.activeMilestone.id, status: tickState.activeMilestone.status }
              : null;
          } catch {
            lastTickStatus = null;
          }
          curriculumView = { activeMilestone: tickState.activeMilestone, completedMilestones: tickState.completedMilestones, drift: driftForContext(readinessDrift) };
          if (!curriculumStarted) {
            curriculumStarted = true;
            decisions.record('curriculum_started', { step, active: tickState.activeMilestone ? tickState.activeMilestone.id : null, completed: tickState.completedMilestones });
          }
          for (const id of tickState.newlySkipped || []) {
            decisions.record('milestone_skipped_already_satisfied', { step, milestone: id });
          }
          for (const id of tickState.newlyCompleted || []) {
            decisions.record('milestone_completed', { step, milestone: id, inventory: summarizeInventoryCounts(perception) });
          }
          if (tickState.activeMilestone && tickState.activeChanged) {
            decisions.record('milestone_selected', { step, milestone: tickState.activeMilestone.id, reason: tickState.activeMilestone.reason });
          }
          const want = tickState.activeMilestone;
          const have = gsNow.currentGoal;
          if (want && shouldCurriculumSync(have, want, lastCurriculumGoal)) {
            const prev = have?.description || null;
            goalManager.setGoal(want.description, { priority: 70, reason: `Curriculum milestone: ${want.id}`, subgoals: [] });
            metrics.inc('goalChanges');
            decisions.record('goal_changed', { from: prev, to: want.description, reason: `curriculum:${want.id}`, step });
            lastCurriculumGoal = want.description;
          }
        }
      } catch {
        // curriculum must never break the loop
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

      // 4-5. Fresh cognition every tick. executeNextStep() below awaits the
      // whole primitive/skill, so when it returns there is NO in-progress
      // action to "continue" — replaying the last decision would re-run a
      // completed action blindly (the old 4x move_near bug). Each completed
      // step produces new information, so the next action always comes from
      // a fresh decision. (needsPlanner gating belonged to the removed
      // multi-step plan architecture; autonomous-v2 plans per action.)
      const significantEvent = inferSignificantEvent(lastResult, perception, seenValuables, milestoneItems);
      if (significantEvent) pushEvent({ type: significantEvent.type, step });

      // Known skills for validation + prompt.
      let knownSkills = [];
      try {
        knownSkills = skillLibrary.list();
      } catch {
        knownSkills = [];
      }
      const knownSkillNames = knownSkills.map((s) => s.name).concat(knownSkills.map((s) => s.id));

      // Progress-aware loop signals: what did recent actions actually change,
      // and is navigation cycling the same ground?
      const stagnation = actionHistory.detectStagnation();
      const cellPattern = explorationState.detectOscillation();
      const oscillation = cellPattern.detected && !recentProgress(actionHistory)
        ? { detected: true, cells: cellPattern.cells, withoutProgress: true }
        : { detected: false };
      if (stagnation.detected) {
        decisions.record('stagnation', { step, ...stagnation });
        pushEvent({ type: 'stagnation', step, action: stagnation.repeatedAction });
      }
      if (oscillation.detected) {
        decisions.record('oscillation', { step, ...oscillation });
        pushEvent({ type: 'oscillation', step });
      }

      let decision = null;
      {
        const context = buildContext({
          directive,
          goalState: goalManager.getState(),
          perception,
          lastResult,
          recentEvents,
          relevantMemories: relevant,
          availableSkills: rankRelevantSkills(knownSkills, relevant),
          exploration: explorationSummary(perception, resourceFailStreak),
          deathSignal: deathSignalFor(recentDeaths),
          actionHistory: actionHistory.summary(),
          stagnation,
          oscillation,
          curriculum: curriculumView,
        });
        try {
          const { decision: validated } = await planAutonomous({ context, knownSkillNames });
          decision = validated;
          consecutivePlannerFailures = 0;
          applyGoalChange({ validated, goalManager, step });
          decisions.record('decision', {
            step,
            contract: 'autonomous-v2',
            assessment: validated.assessment?.slice(0, 300),
            goalChange: validated.goalChange?.description || null,
            nextStep: validated.nextStep,
          });
          // Readiness-drift observation (§10/§11): craft milestone ready
          // but the fresh decision goes elsewhere. Counted, never overridden.
          try {
            readinessDrift = updateReadinessDrift({
              drift: readinessDrift,
              status: lastTickStatus,
              nextStep: validated.nextStep,
              emergency: !!(topInterrupt && isUrgent(topInterrupt)),
            });
            if (readinessDrift.deferred) {
              const st = readinessDrift.status;
              decisions.record('curriculum_missed_ready_action', {
                step,
                milestone: readinessDrift.milestoneId,
                selectedAction: stepName(validated.nextStep),
                materialsReady: !!(st && st.materialsReady),
                requiresTable: !!(st && st.requiresTable),
                tableNearby: st ? st.tableNearby : null,
                knownStationDistance: st && st.knownStation ? st.knownStation.distance : null,
              });
            }
          } catch {
            // telemetry must never break cognition
          }
        } catch (err) {
          consecutivePlannerFailures += 1;
          metrics.inc('llmErrors');
          logger.error(`Step ${step}: autonomous planner failed (${consecutivePlannerFailures}/${maxPlannerFailures}): ${err?.message || err}`);
          decisions.record('planner_failed', { step, contract: 'autonomous-v2', error: String(err?.message || err).slice(0, 300), consecutive: consecutivePlannerFailures, category: categorizePlannerError(err), model: process.env.OPENROUTER_MODEL || null });
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
          await sleep(delayMs);
          continue;
        }
      }

      // 6. The one meaningful step from the fresh decision.
      const nextStep = decision.nextStep;

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
      // RESOURCE failures with no progress. Movement and other successes must
      // NOT reset it (a successful walk is not resource progress); only a
      // resource step that actually yields something clears the streak.
      const pname = (result && (result.primitive || result.action)) || null;
      const isResourceStep =
        pname === 'mine_block' ||
        pname === 'mine_block_type' ||
        pname === 'find_block' ||
        pname === 'collect_logs';
      if (isResourceStep) {
        let progressed = false;
        if (result && result.ok) {
          if (typeof result.collected === 'number') progressed = result.collected > 0;
          else if (typeof result.dropCollected === 'boolean') progressed = result.dropCollected;
          else if (pname === 'find_block') progressed = true;
          else if (typeof result.broken === 'number') progressed = result.broken > 0 && result.dropObtained !== false;
          else progressed = true;
        }
        if (progressed) resourceFailStreak = 0;
        else resourceFailStreak += 1;
      }
      lastResult = result;
      // Anchor trusted workstation facts from verified body outcomes.
      try {
        anchorWorkstationFromResult({ result, bot, step });
      } catch {
        // ignore
      }

      // 8. Post-step perception + reflection.
      let perceptionAfter = null;
      try {
        perceptionAfter = observe(bot, { cache, worldMemory });
      } catch {
        perceptionAfter = null;
      }
      // Compact history: what was tried and what actually changed.
      // Positions/inventories come from these bounded snapshots.
      try {
        const before = invTotals(perception);
        const after = invTotals(perceptionAfter || perception);
        actionHistory.record({
          step,
          nextStep,
          result,
          posBefore: posOf(perception),
          posAfter: posOf(perceptionAfter || perception),
          invBefore: before.total,
          invAfter: after.total,
        });
      } catch {
        // history must never break the loop
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



// Bounded perception helpers for the compact action history.
function posOf(perception) {
  try {
    const p = perception && (perception.position || (perception.self && perception.self.position));
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) return null;
    return { x: p.x, y: p.y, z: p.z };
  } catch {
    return null;
  }
}

function invTotals(perception) {
  let total = 0;
  let logs = 0;
  try {
    const inv = (perception && perception.inventory) || {};
    for (const [name, count] of Object.entries(inv)) {
      const n = Number(count);
      if (!Number.isFinite(n)) continue;
      total += n;
      if (typeof name === 'string' && name.endsWith('_log')) logs += n;
    }
  } catch {
    // ignore
  }
  return { total, logs };
}

// Any meaningful progress in recent history (for oscillation gating).
function recentProgress(actionHistory, last = 4) {
  try {
    return actionHistory.summary(last).some((e) => e && e.progress === true);
  } catch {
    return false;
  }
}

// Pure sync rule (exported for tests): curriculum creates the initial goal
// and advances its own previous goal. A differing current goal means the
// model (or emergency resume) owns it — leave it alone.
function shouldCurriculumSync(currentGoal, wantMilestone, lastCurriculumGoal) {
  if (!wantMilestone) return false;
  if (!currentGoal) return true;
  return currentGoal.description === lastCurriculumGoal && currentGoal.description !== wantMilestone.description;
}

// Actions that move TOWARD a ready craft milestone (craft it, place the
// needed table, or travel to the known station). Anything else while ready
// is an observed deferral — counted for cognition, never overridden.
const READY_PROGRESS_ACTIONS = new Set(['craft_item', 'place_block_nearby', 'move_to_known_location']);

function stepName(nextStep) {
  try {
    if (!nextStep || typeof nextStep !== 'object') return '?';
    return `${nextStep.type === 'skill' ? 'skill' : 'primitive'}:${nextStep.name || '?'}`;
  } catch {
    return '?';
  }
}

function updateReadinessDrift({ drift, status, nextStep, emergency }) {
  const base = drift && typeof drift === 'object' ? { ...drift } : { milestoneId: null, count: 0 };
  delete base.deferred;
  delete base.status;
  const id = status && status.id ? status.id : null;
  const ready = !!(status && status.status && status.status.materialsReady === true);
  // Reset on milestone change, emergency, non-craft milestones, or progress.
  if (emergency || !id || !ready || (base.milestoneId && base.milestoneId !== id)) {
    return { milestoneId: ready && !emergency ? id : base.milestoneId, count: 0 };
  }
  const name = nextStep && typeof nextStep.name === 'string' ? nextStep.name : '';
  if (READY_PROGRESS_ACTIONS.has(name)) {
    return { milestoneId: id, count: 0 };
  }
  const count = (base.milestoneId === id ? base.count : 0) + 1;
  const out = { milestoneId: id, count };
  if (count >= 1) {
    out.deferred = true;
    out.status = status.status;
  }
  return out;
}

function driftForContext(drift) {
  try {
    if (drift && drift.milestoneId && drift.count >= 2) {
      return {
        detected: true,
        milestone: drift.milestoneId,
        reason: 'materials are ready but crafting has been deferred repeatedly',
      };
    }
  } catch {
    // ignore
  }
  return { detected: false };
}

function listWorldLocations(worldMemory) {
  const out = [];
  try {
    if (!worldMemory || typeof worldMemory.list !== 'function') return out;
    for (const e of worldMemory.list() || []) {
      if (!e || typeof e.name !== 'string' || !e.position) continue;
      out.push({ name: e.name, position: e.position, metadata: e.metadata || {} });
      if (out.length >= 20) break;
    }
  } catch {
    // ignore
  }
  return out;
}

// Trusted workstation anchoring (§1/§2): coordinates ONLY from verified
// body outcomes — placed positions or tables actually used in a craft.
// Never from LLM text. Memory writes stay in this agent layer.
function anchorWorkstationFromResult({ result, bot, step }) {
  try {
    if (!result || result.ok !== true) return null;
    if (typeof memoryEnabled !== 'function' || !memoryEnabled()) return null;
    const dim = (() => {
      try {
        const d = bot && bot.game && bot.game.dimension;
        if (typeof d === 'string' && d) return d;
      } catch {
        // ignore
      }
      return 'overworld';
    })();
    const numPos = (p) => {
      if (!p || !Number.isFinite(Number(p.x)) || !Number.isFinite(Number(p.y)) || !Number.isFinite(Number(p.z))) return null;
      return { x: Number(p.x), y: Number(p.y), z: Number(p.z) };
    };
    const placedItem = result.item || result.block;
    if ((result.primitive === 'place_block_nearby' || result.primitive === 'place_block') && placedItem === 'crafting_table') {
      const pos = numPos(result.position);
      if (!pos) return null;
      const world = require('../memory/world');
      const res = world.remember('crafting_station', pos, { kind: 'workstation', block: 'crafting_table', source: 'trusted_placement' }, dim);
      if (res?.ok) {
        try { metrics.inc('memoriesWritten'); } catch { /* ignore */ }
        decisions.record('station_anchored', { step, source: 'trusted_placement', position: pos });
        return pos;
      }
      return null;
    }
    if (result.primitive === 'craft_item' && result.craftingTablePosition) {
      const pos = numPos(result.craftingTablePosition);
      if (!pos) return null;
      const world = require('../memory/world');
      const res = world.remember('crafting_station', pos, { kind: 'workstation', block: 'crafting_table', source: 'trusted_use' }, dim);
      if (res?.ok) {
        try { metrics.inc('memoriesWritten'); } catch { /* ignore */ }
        decisions.record('station_anchored', { step, source: 'trusted_use', position: pos });
        return pos;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

// Compact inventory counts for milestone telemetry (top items only).
function summarizeInventoryCounts(perception) {
  const out = {};
  try {
    const inv = (perception && perception.inventory) || {};
    const entries = Object.entries(inv)
      .filter(([, n]) => Number.isFinite(Number(n)) && Number(n) > 0)
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .slice(0, 8);
    for (const [name, count] of entries) out[name] = Number(count);
  } catch {
    // ignore
  }
  return out;
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

// Goal update for the slim contract: a present goalChange replaces the
// current goal; null keeps it. No description-drift replacement, so goals
// cannot thrash. Skill creation and memory creation are NOT hot-path
// behaviors: skills execute from the existing library, memories are written
// by reflection/outcome paths (death, milestones, discoveries) instead of
// every reasoning turn. Skill generation stays available as a separate
// operation (src/skills/generator.js); a future trigger is repeated
// successful primitive sequences or reflection-identified procedures.
function applyGoalChange({ validated, goalManager, step }) {
  const incoming = validated.goalChange || null;
  if (!incoming) {
    logger.debug('Keeping current goal; planner sent goalChange:null.');
    return;
  }
  const prev = goalManager.getState().currentGoal?.description || null;
  goalManager.setGoal(incoming.description, {
    priority: incoming.priority,
    reason: incoming.reason,
    subgoals: [],
  });
  metrics.inc('goalChanges');
  decisions.record('goal_changed', { from: prev, to: incoming.description, reason: incoming.reason, step });
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
      metrics.inc('reflectionInvalid');
      decisions.record('reflection_failed', { step, reflectionContract: 'reflection-v2', error: parsed.error });
      return null;
    }
    const r = parsed.value;
    metrics.inc('reflections');
    metrics.inc('reflectionValid');
    decisions.record('reflection', { step, reflectionContract: 'reflection-v2', summary: r.summary.slice(0, 300), lesson: (r.lesson || '').slice(0, 300), memory: r.memory ? r.memory.kind : null });
    logger.info(`Reflection: ${r.summary}`);

    // At most one memory per reflection; no goal changes, no skill work.
    // Goal management belongs to cognition/curriculum.
    if (memoryEnabled() && r.memory) {
      try {
        if (r.memory.kind === 'semantic') {
          const w = writeSemanticMemory({ ...r.memory, source: 'reflection' });
          if (w?.ok) metrics.inc('memoriesWritten');
        } else if (r.memory.kind === 'episodic') {
          const w = writeEpisodicMemory({
            summary: r.memory.summary,
            lesson: r.memory.lesson || '',
            context: { position: stateAfter?.position || null },
          });
          if (w?.ok) metrics.inc('memoriesWritten');
        }
      } catch {
        // ignore
      }
    }
    return r;
  } catch (err) {
    metrics.inc('llmErrors');
    metrics.inc('reflectionInvalid');
    decisions.record('reflection_failed', { step, reflectionContract: 'reflection-v2', error: String(err?.message || err).slice(0, 300) });
    return null;
  }
}

module.exports = { runAgentLoop, runBenchmarkLoop, runAutonomousLoop, safeFallback, shouldCurriculumSync, anchorWorkstationFromResult, updateReadinessDrift, driftForContext };
