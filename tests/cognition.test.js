'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { validateAutonomousDecision, needsPlanner } = require('../src/agent/cognition');
const { buildContext } = require('../src/agent/context');
const { runBenchmarkLoop } = require('../src/agent/loop');

// Slim hot-path contract (autonomous-v2): assessment + optional goalChange
// + exactly one nextStep. No plan[], no proposeSkill, no memoryToCreate.
function goodDecision() {
  return {
    assessment: 'Night approaching, no shelter.',
    goalChange: null,
    nextStep: { type: 'primitive', name: 'move_near', args: { x: 1, y: 64, z: 1 } },
  };
}

test('valid primitive decision passes', () => {
  const res = validateAutonomousDecision(goodDecision());
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.value.goalChange, null);
  assert.strictEqual(res.value.nextStep.name, 'move_near');
});

test('valid skill decision passes for known skills', () => {
  const d = goodDecision();
  d.nextStep = { type: 'skill', name: 'real_skill', args: {} };
  const res = validateAutonomousDecision(d, { knownSkillNames: new Set(['real_skill']) });
  assert.strictEqual(res.ok, true);
});

test('null goalChange keeps the goal; valid goalChange passes', () => {
  assert.strictEqual(validateAutonomousDecision(goodDecision()).value.goalChange, null);
  const d = goodDecision();
  d.goalChange = { description: 'Find a new source of wood', priority: 70, reason: 'exhausted' };
  const res = validateAutonomousDecision(d);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.value.goalChange.priority, 70);
});

test('unknown top-level fields rejected (incl. obsolete rich fields)', () => {
  for (const extra of ['plan', 'proposeSkill', 'memoryToCreate', 'goal', 'foo']) {
    const d = { ...goodDecision(), [extra]: extra === 'goal' ? { description: 'x' } : [] };
    const res = validateAutonomousDecision(d);
    assert.strictEqual(res.ok, false, extra);
    assert.match(res.error, /Unexpected decision field/);
  }
});

test('missing nextStep rejected', () => {
  const d = goodDecision();
  delete d.nextStep;
  const res = validateAutonomousDecision(d);
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /nextStep is required/);
});

test('unknown primitive rejected', () => {
  const d = goodDecision();
  d.nextStep = { type: 'primitive', name: 'fly', args: {} };
  assert.strictEqual(validateAutonomousDecision(d).ok, false);
});

test('invalid primitive args rejected', () => {
  const d = goodDecision();
  d.nextStep = { type: 'primitive', name: 'attack_entity', args: {} }; // entityId required
  assert.strictEqual(validateAutonomousDecision(d).ok, false);
  const e = goodDecision();
  e.nextStep = { type: 'primitive', name: 'equip_item', args: { item: 'x', destination: 'pocket' } };
  assert.strictEqual(validateAutonomousDecision(e).ok, false);
});

test('unknown skill rejected', () => {
  const d = goodDecision();
  d.nextStep = { type: 'skill', name: 'nope', args: {} };
  assert.strictEqual(validateAutonomousDecision(d, { knownSkillNames: new Set(['real_skill']) }).ok, false);
});

test('assessment length bound enforced', () => {
  const d = goodDecision();
  d.assessment = 'x'.repeat(501);
  assert.strictEqual(validateAutonomousDecision(d).ok, false);
  const e = goodDecision();
  e.assessment = '   ';
  assert.strictEqual(validateAutonomousDecision(e).ok, false);
});

test('goal description and priority bounds enforced', () => {
  const d = goodDecision();
  d.goalChange = { description: '', priority: 70 };
  assert.strictEqual(validateAutonomousDecision(d).ok, false);
  const e = goodDecision();
  e.goalChange = { description: 'x'.repeat(201), priority: 70 };
  assert.strictEqual(validateAutonomousDecision(e).ok, false);
  const f = goodDecision();
  f.goalChange = { description: 'ok', priority: 999 };
  assert.strictEqual(validateAutonomousDecision(f).value.goalChange.priority, 100);
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
  // Typed transport/provider errors keep their own categories: a timeout or
  // HTTP failure must never be reported as a JSON parse failure.
  assert.strictEqual(categorizePlannerError({ code: 'transport_timeout', message: 'timed out' }), 'transport_timeout');
  assert.strictEqual(categorizePlannerError({ code: 'transport_network', message: 'socket hang up' }), 'transport_network');
  assert.strictEqual(categorizePlannerError({ code: 'transport_http', message: 'OpenRouter HTTP 502' }), 'transport_http');
  assert.strictEqual(categorizePlannerError({ code: 'provider_response_invalid', message: 'no assistant content' }), 'provider_response_invalid');
  // Model answered, but the content was not extractable JSON.
  assert.strictEqual(categorizePlannerError(new Error('Planner returned invalid JSON: {"assessment"')), 'parse_failure');
  assert.strictEqual(categorizePlannerError(new Error('Planner returned non-JSON: hello')), 'parse_failure');
  // Valid JSON rejected by the local validator.
  assert.strictEqual(categorizePlannerError(new Error('Planner output failed validation: Invalid plan step: Unknown primitive: fly')), 'unknown_primitive');
  assert.strictEqual(categorizePlannerError(new Error('Invalid plan step: Unknown skill: foo')), 'unknown_skill');
  assert.strictEqual(categorizePlannerError(new Error('Unexpected decision field: "plan"')), 'unexpected_fields');
  assert.strictEqual(categorizePlannerError(new Error('Unexpected goalChange field: "createdAt"')), 'unexpected_fields');
  assert.strictEqual(categorizePlannerError(new Error('attack_entity: unexpected argument "speed"')), 'invalid_args');
  assert.strictEqual(categorizePlannerError(new Error('mine_block: missing required argument "x"')), 'invalid_args');
  assert.strictEqual(categorizePlannerError(new Error('lookup_recipe: forbidden field "url"')), 'invalid_args');
  assert.strictEqual(categorizePlannerError(new Error('assessment must be a non-empty string (max 500 chars)')), 'schema_validation');
  assert.strictEqual(categorizePlannerError(new Error('nextStep is required')), 'schema_validation');
  assert.strictEqual(categorizePlannerError(new Error('something completely different')), 'other');
});

test('unknown skill names fail even with an empty library', () => {
  const { validateAutonomousDecision } = require('../src/agent/cognition');
  const bad = {
    assessment: 'test',
    goalChange: null,
    nextStep: { type: 'skill', name: 'explore_for_trees_and_table', args: {} },
  };
  const res = validateAutonomousDecision(bad, { knownSkillNames: new Set() });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /Unknown skill/);
});
