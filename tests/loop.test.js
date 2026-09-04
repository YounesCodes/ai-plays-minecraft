'use strict';

// Multi-turn autonomous loop test (the history gap: cognition pieces were
// tested independently, so the plan[0]/nextStep double-execution survived).
// Runs runAutonomousLoop for a few ticks with a stubbed planner and stubbed
// step execution, then asserts the exact execution order.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

test('autonomous loop executes plan steps once each, in order', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-test-'));
  process.env.MEMORY_DIR = tmp;
  process.env.LOG_DIR = tmp;

  const plannerPath = require.resolve('../src/agent/planner');
  const actionsPath = require.resolve('../src/agent/actions');
  const realPlanner = require.cache[plannerPath];
  const realActions = require.cache[actionsPath];

  const stepA = { type: 'primitive', name: 'wait', args: { seconds: 1 } };
  const stepB = { type: 'primitive', name: 'wait', args: { seconds: 2 } };
  const stepC = { type: 'primitive', name: 'wait', args: { seconds: 3 } };
  let plannerCalls = 0;
  const executed = [];

  // NOTE: the stub returns the loop's internal "validated" shape directly:
  // loop.js consumes validated.plan / validated.nextStep / validated.goal /
  // validated.proposeSkill / validated.memoryToCreate / validated.assessment.
  // First plan deliberately repeats nextStep as plan[0] (the shape the
  // prompt example shows). The loop must NOT execute it twice.
  const fullA = {
    assessment: { summary: 'test' },
    goal: { description: 'test goal', priority: 50, reason: 'test', changeGoal: false },
    plan: [stepA, stepB],
    nextStep: stepA,
    proposeSkill: null,
    memoryToCreate: null,
  };
  const fullC = {
    assessment: { summary: 'test' },
    goal: { description: 'test goal', priority: 50, reason: 'test', changeGoal: false },
    plan: [],
    nextStep: stepC,
    proposeSkill: null,
    memoryToCreate: null,
  };
  require.cache[plannerPath] = {
    id: plannerPath,
    filename: plannerPath,
    loaded: true,
    exports: {},
  };
  require.cache[actionsPath] = {
    id: actionsPath,
    filename: actionsPath,
    loaded: true,
    exports: {
      executeAction: async () => ({ ok: true }),
      executeNextStep: async (bot, nextStep) => {
        executed.push(JSON.parse(JSON.stringify(nextStep)));
        return { ok: true };
      },
    },
  };
  require.cache[plannerPath].exports.planAutonomous = async () => {
    plannerCalls += 1;
    // Real planAutonomous wraps the validated object as { plan: ... }
    // (see loop.js: `const { plan: validated } = await planAutonomous(...)`).
    return plannerCalls === 1 ? { plan: fullA } : { plan: fullC };
  };

  let summary = null;
  let decisionTypes = [];
  try {
    const { runAgentLoop } = require('../src/agent/loop');
    summary = await runAgentLoop(mockBot(), {
      mode: 'autonomous',
      maxSteps: 4,
      decisionDelayMs: 1,
      directive: 'test directive',
    });
    const raw = fs.readFileSync(path.join(tmp, 'decisions.jsonl'), 'utf8');
    decisionTypes = raw
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l).type;
        } catch {
          return '?';
        }
      });
  } finally {
    if (realPlanner) require.cache[plannerPath] = realPlanner;
    else delete require.cache[plannerPath];
    if (realActions) require.cache[actionsPath] = realActions;
    else delete require.cache[actionsPath];
    delete process.env.MEMORY_DIR;
    delete process.env.LOG_DIR;
  }

  assert.strictEqual(summary && summary.status, 'budget_exhausted');
  assert.strictEqual(plannerCalls, 2);
  // A, then B (not A again), then C. The old code executed A twice.
  assert.deepStrictEqual(executed, [stepA, stepB, stepC]);
  // The canned goal ('test goal', changeGoal:false) differs from the loop's
  // default goal, yet must NOT replace it: no goal_changed may be recorded.
  // The old description-drift code recorded two.
  assert.ok(!decisionTypes.includes('goal_changed'), `unexpected goal changes: ${decisionTypes.join(',')}`);
});

test('benchmark deaths count exactly once per death', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-death-test-'));
  process.env.MEMORY_DIR = tmp;
  process.env.LOG_DIR = tmp;
  const deadBot = mockBot();
  deadBot.health = 0;
  deadBot.food = 0;
  let summary = null;
  try {
    const { runAgentLoop } = require('../src/agent/loop');
    summary = await runAgentLoop(deadBot, {
      mode: 'benchmark',
      maxSteps: 3,
      decisionDelayMs: 1,
      goal: 'test goal',
    });
  } finally {
    delete process.env.MEMORY_DIR;
    delete process.env.LOG_DIR;
  }
  assert.strictEqual(summary && summary.status, 'budget_exhausted');
  const metrics = require('../src/telemetry/metrics');
  assert.strictEqual(metrics.get('deaths'), 1);
  const raw = fs.readFileSync(path.join(tmp, 'decisions.jsonl'), 'utf8');
  const deaths = raw
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l).type;
      } catch {
        return '?';
      }
    })
    .filter((t) => t === 'death');
  assert.strictEqual(deaths.length, 1);
});
