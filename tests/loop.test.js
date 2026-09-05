'use strict';

// Multi-turn autonomous loop tests (the history gap: cognition pieces were
// tested independently, so the plan[0]/nextStep double-execution survived).
//
// Stubbing note: loop.js captures planner/actions references at require
// time, so per-test require.cache swaps do NOT rebind an already-loaded
// loop module. These stubs therefore delegate to a per-test behavior object
// set before each run. Do not "restore" the cache mid-file.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const plannerPath = require.resolve('../src/agent/planner');
const actionsPath = require.resolve('../src/agent/actions');
const stubBehavior = {
  planAutonomous: async () => {
    throw new Error('stubBehavior.planAutonomous not configured');
  },
  executeNextStep: async () => {
    throw new Error('stubBehavior.executeNextStep not configured');
  },
};
require.cache[plannerPath] = {
  id: plannerPath,
  filename: plannerPath,
  loaded: true,
  exports: {
    plan: async () => {
      throw new Error('benchmark planner must not run in autonomous tests');
    },
    planAutonomous: async (arg) => stubBehavior.planAutonomous(arg),
  },
};
require.cache[actionsPath] = {
  id: actionsPath,
  filename: actionsPath,
  loaded: true,
  exports: {
    executeAction: async () => ({ ok: true }),
    executeNextStep: async (bot, step) => stubBehavior.executeNextStep(bot, step),
  },
};

const { runAgentLoop, safeFallback } = require('../src/agent/loop');

function mockBot() {
  return {
    health: 20,
    food: 20,
    entity: { position: { x: 0, y: 64, z: 0, distanceTo: () => 5 } },
    time: { timeOfDay: 6000 },
    inventory: { items: () => [] },
    entities: {},
    findBlock: () => null,
    on() {},
    once() {},
  };
}

function freshEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-test-'));
  process.env.MEMORY_DIR = tmp;
  process.env.LOG_DIR = tmp;
  return tmp;
}

function clearEnv() {
  delete process.env.MEMORY_DIR;
  delete process.env.LOG_DIR;
}

function readDecisions(tmp) {
  const raw = fs.readFileSync(path.join(tmp, 'decisions.jsonl'), 'utf8');
  return raw
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { type: '?' };
      }
    });
}

function decisionTypes(tmp) {
  return readDecisions(tmp).map((d) => d.type);
}

test('autonomous loop plans fresh every tick and never replays completed actions', async () => {
  const tmp = freshEnv();
  try {
    const stepA = { type: 'primitive', name: 'wait', args: { seconds: 1 } };
    const stepC = { type: 'primitive', name: 'wait', args: { seconds: 3 } };
    let plannerCalls = 0;
    const executed = [];
    // NOTE: the stub returns the loop's internal shape directly.
    // Slim contract: assessment string + goalChange + one nextStep.
    const fullA = { assessment: 'test A', goalChange: null, nextStep: stepA };
    const fullC = { assessment: 'test C', goalChange: null, nextStep: stepC };
    stubBehavior.planAutonomous = async () => {
      plannerCalls += 1;
      // Real planAutonomous wraps the validated object as { decision: ... }.
      // Alternate decisions: every tick plans fresh (no replay).
      return { decision: plannerCalls % 2 === 1 ? fullA : fullC };
    };
    stubBehavior.executeNextStep = async (bot, nextStep) => {
      executed.push(JSON.parse(JSON.stringify(nextStep)));
      return { ok: true };
    };

    const summary = await runAgentLoop(mockBot(), {
      mode: 'autonomous',
      maxSteps: 5,
      decisionDelayMs: 1,
      directive: 'test directive',
    });
    assert.strictEqual(summary && summary.status, 'budget_exhausted');
    // Every completed action is followed by fresh cognition: one planner
    // call per tick, zero framework-generated repeats.
    assert.strictEqual(plannerCalls, 5);
    assert.deepStrictEqual(executed, [stepA, stepC, stepA, stepC, stepA]);
    // goalChange:null must NOT create or replace any goal, and the
    // curriculum layer must never set one either: with no model goalChange,
    // zero goal changes happen (goal stays null, self-directed).
    const raw = readDecisions(tmp);
    const changes = raw.filter((d) => d.type === 'goal_changed');
    assert.strictEqual(changes.length, 0);
    assert.strictEqual(raw.filter((d) => d.type === 'self_goal_selected').length, 0);
    const types = decisionTypes(tmp);
    assert.ok(!types.includes('repeat'), 'framework must never replay completed actions');
    assert.strictEqual(types.filter((t) => t === 'decision').length, 5);
    // Curriculum authority must be gone: no curriculum goal bootstrap, no
    // tactic preemption events in default autonomous mode.
    assert.ok(!types.includes('curriculum_tactic'));
    assert.ok(!types.includes('milestone_selected'));
    assert.ok(!types.includes('milestone_skipped_already_satisfied'));
    assert.ok(!types.includes('curriculum_missed_ready_action'));
  } finally {
    clearEnv();
  }
});

test('goalChange replaces the goal exactly once', async () => {
  const tmp = freshEnv();
  try {
    const stepA = { type: 'primitive', name: 'wait', args: { seconds: 1 } };
    let plannerCalls = 0;
    stubBehavior.planAutonomous = async () => {
      plannerCalls += 1;
      if (plannerCalls === 1) {
        return { decision: { assessment: 'relocate', goalChange: { description: 'Find wood elsewhere', priority: 70, reason: 'exhausted' }, nextStep: stepA } };
      }
      return { decision: { assessment: 'steady', goalChange: null, nextStep: stepA } };
    };
    stubBehavior.executeNextStep = async () => ({ ok: true });
    await runAgentLoop(mockBot(), { mode: 'autonomous', maxSteps: 3, decisionDelayMs: 1, directive: 'test' });
    // Only one change: the genuine model goalChange (from null). No
    // curriculum bootstrap exists anymore.
    const raw = readDecisions(tmp);
    const changes = raw.filter((d) => d.type === 'goal_changed');
    assert.strictEqual(changes.length, 1);
    assert.ok(!(changes[0].reason || '').startsWith('curriculum:'));
    assert.strictEqual(changes[0].to, 'Find wood elsewhere');
    // The first self-chosen goal is recorded as a selection, not a revision.
    const selected = raw.filter((d) => d.type === 'self_goal_selected');
    assert.strictEqual(selected.length, 1);
    assert.strictEqual(selected[0].goal, 'Find wood elsewhere');
    assert.strictEqual(raw.filter((d) => d.type === 'self_goal_changed').length, 0);
    const types = decisionTypes(tmp);
  } finally {
    clearEnv();
  }
});

test('model goal revision is recorded as self_goal_changed', async () => {
  const tmp = freshEnv();
  try {
    const stepA = { type: 'primitive', name: 'wait', args: { seconds: 1 } };
    let plannerCalls = 0;
    stubBehavior.planAutonomous = async () => {
      plannerCalls += 1;
      if (plannerCalls === 1) {
        return { decision: { assessment: 'first', goalChange: { description: 'Get food', priority: 60, reason: 'hungry' }, nextStep: stepA } };
      }
      if (plannerCalls === 2) {
        return { decision: { assessment: 'second', goalChange: { description: 'Build shelter', priority: 50, reason: 'night coming' }, nextStep: stepA } };
      }
      return { decision: { assessment: 'steady', goalChange: null, nextStep: stepA } };
    };
    stubBehavior.executeNextStep = async () => ({ ok: true });
    await runAgentLoop(mockBot(), { mode: 'autonomous', maxSteps: 3, decisionDelayMs: 1, directive: 'test' });
    const raw = readDecisions(tmp);
    assert.strictEqual(raw.filter((d) => d.type === 'self_goal_selected').length, 1);
    const changed = raw.filter((d) => d.type === 'self_goal_changed');
    assert.strictEqual(changed.length, 1);
    assert.strictEqual(changed[0].goal, 'Build shelter');
    assert.strictEqual(changed[0].reason, 'night coming');
  } finally {
    clearEnv();
  }
});

test('planner owns every decision even when a deterministic tactic would fire', async () => {
  const tmp = freshEnv();
  try {
    // 4 logs: obtain_logs is complete and make_planks is active with
    // materials ready — the retired deterministic tactic layer would have
    // preempted cognition with craft_item(oak_planks) here. The planner must
    // instead own every decision.
    const bot = mockBot();
    bot.inventory = { items: () => [{ name: 'oak_log', count: 4, type: 36 }] };
    const chosen = { type: 'primitive', name: 'explore', args: { distance: 16, direction: 'east' } };
    let plannerCalls = 0;
    stubBehavior.planAutonomous = async () => {
      plannerCalls += 1;
      return { decision: { assessment: 'my own strategic choice', goalChange: null, nextStep: chosen } };
    };
    const executed = [];
    stubBehavior.executeNextStep = async (b, nextStep) => {
      executed.push(JSON.parse(JSON.stringify(nextStep)));
      return { ok: true };
    };
    await runAgentLoop(bot, { mode: 'autonomous', maxSteps: 3, decisionDelayMs: 1, directive: 'test' });
    assert.strictEqual(plannerCalls, 3, 'cognition consulted every tick');
    assert.deepStrictEqual(executed, [chosen, chosen, chosen], 'executed steps come from the planner only');
    const types = decisionTypes(tmp);
    assert.strictEqual(types.filter((t) => t === 'curriculum_tactic').length, 0, 'no deterministic tactic events');
    assert.ok(types.includes('progression_observer_started'), 'observer still running silently');
  } finally {
    clearEnv();
  }
});

test('silent progression observer records achievements without goal authority', async () => {
  const tmp = freshEnv();
  try {
    // Mutable inventory: empty at spawn, logs appear after the first action.
    // The observer must record the in-run achievement (progress_achievement)
    // on the step-2 tick while still creating no goals.
    const bot = mockBot();
    bot.inventory = { items: () => [] };
    const stepA = { type: 'primitive', name: 'wait', args: { seconds: 1 } };
    stubBehavior.planAutonomous = async () => ({ decision: { assessment: 'test', goalChange: null, nextStep: stepA } });
    let executedSteps = 0;
    stubBehavior.executeNextStep = async () => {
      executedSteps += 1;
      if (executedSteps === 1) {
        bot.inventory = { items: () => [{ name: 'oak_log', count: 5, type: 36 }] };
      }
      return { ok: true };
    };
    await runAgentLoop(bot, { mode: 'autonomous', maxSteps: 3, decisionDelayMs: 1, directive: 'test' });
    const raw = readDecisions(tmp);
    const types = decisionTypes(tmp);
    // Observer started exactly once and recorded the achievement.
    assert.strictEqual(types.filter((t) => t === 'progression_observer_started').length, 1);
    const achievements = raw.filter((d) => d.type === 'progress_achievement');
    assert.ok(achievements.some((a) => a.id === 'obtain_logs'), 'log achievement observed silently');
    const logs = achievements.find((a) => a.id === 'obtain_logs');
    assert.ok(logs.step >= 2, 'achievement recorded on a later tick, not pre-existing');
    assert.ok(Number.isFinite(logs.elapsedMs), 'achievement carries elapsedMs');
    for (const a of achievements) {
      assert.ok(!a.milestone && !a.nextMilestone, 'no instruction payload in observer events');
    }
    // The observer must NOT create goals or steer.
    assert.strictEqual(raw.filter((d) => d.type === 'goal_changed').length, 0);
    assert.strictEqual(raw.filter((d) => d.type === 'self_goal_selected').length, 0);
    assert.ok(!types.includes('milestone_selected'), 'observer does not select/steer');
  } finally {
    clearEnv();
  }
});

test('requiresRelocation flows into next context and yields explore', async () => {
  const tmp = freshEnv();
  try {
    const mineStep = { type: 'primitive', name: 'mine_block_type', args: { blockType: 'oak_log', count: 4 } };
    const exploreStep = { type: 'primitive', name: 'explore', args: { distance: 32, direction: 'west' } };
    const seenResults = [];
    let plannerCalls = 0;
    const executed = [];
    stubBehavior.planAutonomous = async ({ context }) => {
      plannerCalls += 1;
      seenResults.push(context && context.lastResult ? { ...context.lastResult } : null);
      if (plannerCalls === 1) {
        return { decision: { assessment: 'need wood', goalChange: null, nextStep: mineStep } };
      }
      return { decision: { assessment: 'relocate', goalChange: null, nextStep: exploreStep } };
    };
    stubBehavior.executeNextStep = async (bot, nextStep) => {
      executed.push(JSON.parse(JSON.stringify(nextStep)));
      if (nextStep.name === 'mine_block_type') {
        return { ok: false, primitive: 'mine_block_type', reason: 'no_reachable_target', requiresRelocation: true, candidatesSeen: 30, candidatesDeferred: 18 };
      }
      return { ok: true, primitive: 'explore', distanceMoved: 28 };
    };
    await runAgentLoop(mockBot(), { mode: 'autonomous', maxSteps: 6, decisionDelayMs: 1, directive: 'test' });
    assert.deepStrictEqual(executed[0], mineStep);
    // The failure is visible to the very next cognition (no replay), which
    // yields explore immediately.
    assert.deepStrictEqual(executed[1], exploreStep);
    // The relocation signal must reach cognition honestly (not prose-mined).
    assert.ok(seenResults.some((r) => r && r.requiresRelocation === true), 'next context must carry requiresRelocation');
  } finally {
    clearEnv();
  }
});

test('benchmark deaths count exactly once per death', async () => {
  const tmp = freshEnv();
  try {
    const deadBot = mockBot();
    deadBot.health = 0;
    deadBot.food = 0;
    const summary = await runAgentLoop(deadBot, {
      mode: 'benchmark',
      maxSteps: 3,
      decisionDelayMs: 1,
      goal: 'test goal',
    });
    assert.strictEqual(summary && summary.status, 'budget_exhausted');
    const metrics = require('../src/telemetry/metrics');
    assert.strictEqual(metrics.get('deaths'), 1);
    const deaths = decisionTypes(tmp).filter((t) => t === 'death');
    assert.strictEqual(deaths.length, 1);
  } finally {
    clearEnv();
  }
});

test('safeFallback flees hostiles before eating or waiting', async () => {
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    entities: { 5: { id: 5, position: { x: 3, y: 64, z: 0 } } },
    health: 10,
    food: 20,
    pathfinder: { goto: async () => {}, stop: () => {}, setGoal: () => {} },
    clearControlStates: () => {},
  };
  const perception = {
    self: { health: 10, food: 20 },
    inventory: {},
    nearbyEntitiesDetailed: [{ id: 5, type: 'zombie', hostile: true, distance: 5 }],
  };
  const res = await safeFallback(bot, perception, { type: 'immediate_threat', entityId: 5 });
  assert.strictEqual(res.primitive, 'move_away_from_entity');
  assert.strictEqual(res.ok, true);
});

test('safeFallback eats when hungry with food, waits otherwise', async () => {
  const bot = {
    food: 10,
    inventory: { items: () => [{ name: 'bread', count: 2 }] },
    consume: async () => {
      bot.food = 20;
    },
    entities: {},
  };
  const hungry = { self: { health: 20, food: 10 }, inventory: { bread: 2 }, nearbyEntitiesDetailed: [] };
  const eatRes = await safeFallback(bot, hungry, null);
  assert.strictEqual(eatRes.primitive, 'eat_best_food');

  const starving = { self: { health: 20, food: 8 }, inventory: {}, nearbyEntitiesDetailed: [] };
  const waitRes = await safeFallback({ entities: {} }, starving, null);
  assert.strictEqual(waitRes.fallback, true);
  assert.strictEqual(waitRes.primitive, 'wait');
});

test('consecutive resource failures raise localSearchExhausted in context', async () => {
  const tmp = freshEnv();
  try {
    const contexts = [];
    const mineStep = { type: 'primitive', name: 'mine_block_type', args: { blockType: 'oak_log', count: 1 } };
    const canned = { assessment: 'test', goalChange: null, nextStep: mineStep };
    stubBehavior.planAutonomous = async ({ context }) => {
      contexts.push(JSON.parse(JSON.stringify(context.exploration || null)));
      return { decision: canned };
    };
    stubBehavior.executeNextStep = async () => ({
      ok: false,
      primitive: 'mine_block_type',
      error: 'No oak_log found within 64 blocks',
    });
    await runAgentLoop(mockBot(), {
      mode: 'autonomous',
      maxSteps: 8,
      decisionDelayMs: 1,
      directive: 'test',
    });
    assert.ok(contexts.length >= 2, 'planner saw multiple contexts');
    assert.ok(
      contexts.some((c) => c && c.localSearchExhausted === true),
      'exhaustion flag appears after consecutive resource failures'
    );
  } finally {
    clearEnv();
  }
});
