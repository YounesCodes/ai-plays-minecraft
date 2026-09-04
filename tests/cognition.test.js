'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { validatePlannerOutput, needsPlanner } = require('../src/agent/cognition');
const { buildContext } = require('../src/agent/context');
const { runBenchmarkLoop } = require('../src/agent/loop');

function goodPlan() {
  return {
    assessment: { summary: 'Night approaching, no shelter.', immediateThreat: null },
    goal: { description: 'Build a basic shelter', priority: 80, reason: 'Night risk', changeGoal: true },
    plan: [{ type: 'primitive', name: 'move_near', args: { x: 1, y: 64, z: 1 } }],
    nextStep: { type: 'primitive', name: 'move_near', args: { x: 1, y: 64, z: 1 } },
    memoryToCreate: null,
    proposeSkill: null,
  };
}

test('valid planning output passes', () => {
  const res = validatePlannerOutput(goodPlan());
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.value.goal.priority, 80);
});

test('invalid nextStep rejected (unknown primitive)', () => {
  const p = goodPlan();
  p.nextStep = { type: 'primitive', name: 'fly', args: {} };
  assert.strictEqual(validatePlannerOutput(p).ok, false);
});

test('unknown skill rejected when allowlist given', () => {
  const p = goodPlan();
  p.nextStep = { type: 'skill', name: 'nope', args: {} };
  assert.strictEqual(validatePlannerOutput(p, { knownSkillNames: new Set(['real_skill']) }).ok, false);
});

test('interrupt takes priority in planner gating', () => {
  const yes = needsPlanner({ interrupt: { type: 'immediate_threat', priority: 95 }, goalState: { currentGoal: { description: 'mine' } } });
  assert.strictEqual(yes.needed, true);
  const no = needsPlanner({ goalState: { currentGoal: { description: 'mine' } }, lastResult: { ok: true }, ticksSincePlan: 0 });
  assert.strictEqual(no.needed, false);
});

test('skill failure triggers replan gating', () => {
  const r = needsPlanner({
    goalState: { currentGoal: { description: 'mine' } },
    lastResult: { ok: false, error: 'Step failed' },
    ticksSincePlan: 1, consecutiveFailures: 1,
  });
  assert.strictEqual(r.needed, true);
});

test('context builder stays bounded and secret-free', () => {
  const ctx = buildContext({
    directive: 'test',
    goalState: { currentGoal: { description: 'g' }, subgoals: [], suspendedGoal: null },
    perception: {
      self: { health: 20 }, equipment: {}, inventory: { oak_log: 3 },
      environment: {}, nearbyEntitiesDetailed: [], interestingBlocks: [], knownLocationsNearby: [],
    },
    relevantMemories: { semantic: [], episodic: [], procedural: [], world: [] },
    availableSkills: [],
  });
  const text = JSON.stringify(ctx);
  assert.ok(!/OPENROUTER_API_KEY/.test(text));
  assert.ok(text.length < 20000);
});

test('no duplicate loop after respawn guard', async () => {
  const bot = {
    __agentLoopRunning: true,
    on: () => {}, once: () => {},
  };
  const { runAgentLoop } = require('../src/agent/loop');
  const res = await runAgentLoop(bot, { mode: 'benchmark' });
  assert.strictEqual(res.status, 'already_running');
});

test('benchmark loop completes when logs already present (no LLM)', async () => {
  const bot = {
    __agentLoopRunning: false,
    health: 20, food: 20,
    entity: { position: { x: 0, y: 64, z: 0 } },
    time: { timeOfDay: 1000 },
    inventory: { items: () => [{ name: 'oak_log', count: 8 }], slots: [] },
    entities: {},
    on: () => {}, once: () => {},
  };
  const res = await runBenchmarkLoop(bot, { goal: 'test', maxSteps: 5, decisionDelayMs: 0 });
  assert.strictEqual(res.status, 'completed');
  assert.strictEqual(res.logs, 8);
});

test('categorizePlannerError buckets invalid planner output', () => {
  const { categorizePlannerError } = require('../src/agent/cognition');
  assert.strictEqual(categorizePlannerError(new Error('OpenRouter returned invalid JSON')), 'parse-failure');
  assert.strictEqual(categorizePlannerError(new Error('Invalid plan step: Unknown primitive: fly')), 'unknown-primitive');
  assert.strictEqual(categorizePlannerError(new Error('Invalid plan step: Unknown skill: foo')), 'unknown-skill');
  assert.strictEqual(categorizePlannerError(new Error('plan has too many steps (max 12)')), 'plan-too-long');
  assert.strictEqual(categorizePlannerError(new Error('Invalid proposeSkill: Skill id must be a non-empty string (max 80 chars)')), 'skill-schema');
  assert.strictEqual(categorizePlannerError(new Error('attack_entity: unexpected argument "speed"')), 'invalid-args');
  assert.strictEqual(categorizePlannerError(new Error('mine_block: missing required argument "x"')), 'missing-fields');
  assert.strictEqual(categorizePlannerError(new Error('something completely different')), 'other');
});
