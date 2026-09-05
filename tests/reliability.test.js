'use strict';

// Loop-level reliability/traceability tests: goal reaffirmation, goal age,
// memory retrieval telemetry matching the planner context, and reflection
// memory writes traceable by the actual store ID. Stub modules are injected
// into the require cache BEFORE the loop loads (same pattern as
// loop.test.js; node --test runs each file in its own process).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const plannerPath = require.resolve('../src/agent/planner');
const actionsPath = require.resolve('../src/agent/actions');
const openrouterPath = require.resolve('../src/llm/openrouter');
const semanticPath = require.resolve('../src/memory/semantic');
const episodicPath = require.resolve('../src/memory/episodic');

const stubBehavior = {
  planAutonomous: async () => {
    throw new Error('stubBehavior.planAutonomous not configured');
  },
  executeNextStep: async () => ({ ok: true }),
  reflectionResponse: {
    summary: 'Craft failed for missing materials.',
    lesson: 'Check materials before crafting.',
    memory: { kind: 'semantic', subject: 'Crafting needs materials', content: 'Always gather materials before crafting an item.', confidence: 0.7 },
  },
};

require.cache[plannerPath] = {
  id: plannerPath,
  filename: plannerPath,
  loaded: true,
  exports: {
    plan: async () => { throw new Error('benchmark planner must not run here'); },
    planAutonomous: async (arg) => stubBehavior.planAutonomous(arg),
    AUTONOMOUS_CONTRACT: 'autonomous-v2',
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
// OpenRouter stub: only reflection calls reach it in this file (planner is
// stubbed wholesale above).
require.cache[openrouterPath] = {
  id: openrouterPath,
  filename: openrouterPath,
  loaded: true,
  exports: {
    complete: async () => ({
      content: JSON.stringify(stubBehavior.reflectionResponse),
      model: 'stub',
      usage: null,
    }),
  },
};
// Memory stores with fixed, observable IDs.
const semanticStore = [];
const episodicStore = [];
require.cache[semanticPath] = {
  id: semanticPath,
  filename: semanticPath,
  loaded: true,
  exports: {
    list: () => semanticStore.slice(),
    add: (p) => {
      const entry = { id: `sem_${semanticStore.length + 1}`, type: 'semantic', subject: p.subject, content: p.content, confidence: p.confidence ?? 0.6, source: p.source || 'reflection', createdAt: 't', updatedAt: 't' };
      semanticStore.push(entry);
      return { ok: true, id: entry.id };
    },
  },
};
require.cache[episodicPath] = {
  id: episodicPath,
  filename: episodicPath,
  loaded: true,
  exports: {
    list: () => episodicStore.slice(),
    add: (p) => {
      const entry = { id: `epi_${episodicStore.length + 1}`, type: 'episodic', summary: p.summary, lesson: p.lesson || '', context: p.context || {}, createdAt: 't' };
      episodicStore.push(entry);
      return { ok: true, id: entry.id };
    },
  },
};

const { runAgentLoop } = require('../src/agent/loop');
const { buildContext } = require('../src/agent/context');
const { normalizeGoalText } = require('../src/agent/goals');

function mockBot() {
  return {
    health: 20,
    food: 20,
    entity: { position: { x: 0, y: 64, z: 0 } },
    time: { timeOfDay: 6000 },
    inventory: { items: () => [] },
    entities: {},
    findBlock: () => null,
    on() {},
    once() {},
  };
}

function freshEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-test-'));
  process.env.MEMORY_DIR = tmp;
  process.env.LOG_DIR = tmp;
  return tmp;
}

function readDecisions(tmp) {
  return fs.readFileSync(path.join(tmp, 'decisions.jsonl'), 'utf8')
    .split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return { type: '?' }; } });
}

test('normalizeGoalText: trim, collapse whitespace, case-insensitive', () => {
  assert.strictEqual(normalizeGoalText('  Get   WOOD  '), normalizeGoalText('get wood'));
  assert.notStrictEqual(normalizeGoalText('get wood'), normalizeGoalText('get logs'));
});

test('exact goal reaffirmation does not replace the goal or pollute change metrics', async () => {
  const tmp = freshEnv();
  semanticStore.length = 0;
  episodicStore.length = 0;
  try {
    const wait = { type: 'primitive', name: 'wait', args: { seconds: 1 } };
    const goalA = { description: 'Gather wood near camp', priority: 60, reason: 'need wood' };
    let plannerCalls = 0;
    stubBehavior.planAutonomous = async () => {
      plannerCalls += 1;
      if (plannerCalls === 1) return { decision: { assessment: 'set', goalChange: goalA, nextStep: wait } };
      if (plannerCalls === 2) return { decision: { assessment: 'same', goalChange: { description: 'gather wood near   CAMP', priority: 60, reason: 'still need wood' }, nextStep: wait } };
      return { decision: { assessment: 'same again', goalChange: { description: 'Gather Wood Near Camp', priority: 60, reason: 'reaffirm' }, nextStep: wait } };
    };
    await runAgentLoop(mockBot(), { mode: 'autonomous', maxSteps: 3, decisionDelayMs: 1, directive: 'test' });
    const raw = readDecisions(tmp);
    // First is a real selection; the two normalized-equal re-assertions are
    // reaffirmations only.
    assert.strictEqual(raw.filter((d) => d.type === 'self_goal_selected').length, 1);
    const reaffirmed = raw.filter((d) => d.type === 'self_goal_reaffirmed');
    assert.strictEqual(reaffirmed.length, 2);
    assert.strictEqual(reaffirmed[0].goal, 'gather wood near   CAMP');
    assert.strictEqual(raw.filter((d) => d.type === 'goal_changed').length, 1, 'reaffirmations must not create goal_changed events');
    assert.strictEqual(raw.filter((d) => d.type === 'self_goal_changed').length, 0);
  } finally {
    delete process.env.MEMORY_DIR;
    delete process.env.LOG_DIR;
  }
});

test('a genuinely different goal still replaces (and resets age)', async () => {
  const tmp = freshEnv();
  semanticStore.length = 0;
  episodicStore.length = 0;
  try {
    const wait = { type: 'primitive', name: 'wait', args: { seconds: 1 } };
    let plannerCalls = 0;
    stubBehavior.planAutonomous = async () => {
      plannerCalls += 1;
      if (plannerCalls === 1) return { decision: { assessment: 'a', goalChange: { description: 'Mine coal', priority: 60, reason: 'torches' }, nextStep: wait } };
      return { decision: { assessment: 'b', goalChange: { description: 'Build a shelter', priority: 50, reason: 'night' }, nextStep: wait } };
    };
    await runAgentLoop(mockBot(), { mode: 'autonomous', maxSteps: 3, decisionDelayMs: 1, directive: 'test' });
    const raw = readDecisions(tmp);
    // Step 1 selects 'Mine coal'; step 2 changes to 'Build a shelter'; step
    // 3 re-asserts 'Build a shelter' (a reaffirmation, not a change).
    assert.strictEqual(raw.filter((d) => d.type === 'self_goal_selected').length, 1);
    assert.strictEqual(raw.filter((d) => d.type === 'self_goal_changed').length, 1);
    assert.strictEqual(raw.filter((d) => d.type === 'self_goal_reaffirmed').length, 1);
    assert.strictEqual(raw.filter((d) => d.type === 'goal_changed').length, 2);
  } finally {
    delete process.env.MEMORY_DIR;
    delete process.env.LOG_DIR;
  }
});

test('goalAgeSteps is factual: set at selection, kept on reaffirmation', () => {
  const goalState = { currentGoal: { description: 'Mine coal', activatedAtStep: 3 } };
  const ctx = buildContext({ directive: 'd', goalState, perception: null, currentStep: 9 });
  assert.strictEqual(ctx.goalAgeSteps, 6);
  const noAge = buildContext({ directive: 'd', goalState: { currentGoal: { description: 'x' } }, perception: null, currentStep: 9 });
  assert.strictEqual(noAge.goalAgeSteps, null);
  const noGoal = buildContext({ directive: 'd', goalState: { currentGoal: null }, perception: null, currentStep: 9 });
  assert.strictEqual(noGoal.goalAgeSteps, null);
});

test('memory_retrieved telemetry exactly matches the bounded planner memories', async () => {
  const tmp = freshEnv();
  semanticStore.length = 0;
  episodicStore.length = 0;
  try {
    // Seed store entries the keyword retriever can match to a wood goal.
    semanticStore.push(
      { id: 'sem_a', type: 'semantic', subject: 'Wood gathering', content: 'Oak logs are abundant in forests.', confidence: 0.8, source: 'reflection', createdAt: 't', updatedAt: 't' },
      { id: 'sem_b', type: 'semantic', subject: 'Water hazard', content: 'Avoid deep rivers without a boat.', confidence: 0.7, source: 'reflection', createdAt: 't', updatedAt: 't' }
    );
    episodicStore.push({ id: 'epi_a', type: 'episodic', summary: 'Got stuck exploring at night.', lesson: 'Carry food.', context: {}, createdAt: 't' });
    const wait = { type: 'primitive', name: 'wait', args: { seconds: 1 } };
    const contexts = [];
    stubBehavior.planAutonomous = async ({ context }) => {
      contexts.push(context);
      return { decision: { assessment: 'a', goalChange: { description: 'Gather wood for tools', priority: 60, reason: 'tools' }, nextStep: wait } };
    };
    // Step 1 retrieves with no goal yet; steps 2-3 retrieve with the wood
    // goal active, so the wood memory must appear there.
    await runAgentLoop(mockBot(), { mode: 'autonomous', maxSteps: 3, decisionDelayMs: 1, directive: 'test' });
    const raw = readDecisions(tmp);
    const evts = raw.filter((d) => d.type === 'memory_retrieved');
    assert.ok(evts.length >= 2, 'memory_retrieved recorded every cognition turn');
    const evt = evts[evts.length - 1];
    const captured = contexts[contexts.length - 1];
    // Must mirror what the planner actually received (same bounds/slices).
    assert.deepStrictEqual(evt.semantic, (captured.relevantMemories.semantic || []).map((m) => ({ id: m.id, subject: String(m.subject || '').slice(0, 80) })));
    assert.deepStrictEqual(evt.episodic, (captured.relevantMemories.episodic || []).map((m) => ({ id: m.id, summary: String(m.summary || '').slice(0, 80) })));
    assert.deepStrictEqual(evt.procedural, (captured.relevantMemories.procedural || []).map((m) => ({ id: m.id, skillId: m.skillId })));
    assert.deepStrictEqual(evt.world, (captured.relevantMemories.world || []).map((m) => ({ name: m.name })));
    assert.ok(evt.semantic.some((s) => s.id === 'sem_a'), 'retrieved list contains the matched memory id');
  } finally {
    delete process.env.MEMORY_DIR;
    delete process.env.LOG_DIR;
  }
});

test('reflection memory writes are traceable by the actual store ID', async () => {
  const tmp = freshEnv();
  semanticStore.length = 0;
  episodicStore.length = 0;
  try {
    const failCraft = { type: 'primitive', name: 'craft_item', args: { item: 'wooden_pickaxe' } };
    let plannerCalls = 0;
    stubBehavior.planAutonomous = async () => {
      plannerCalls += 1;
      return { decision: { assessment: 'try craft', goalChange: null, nextStep: failCraft } };
    };
    stubBehavior.executeNextStep = async () => ({ ok: false, primitive: 'craft_item', item: 'wooden_pickaxe', reason: 'missing_materials', error: 'missing materials' });
    await runAgentLoop(mockBot(), { mode: 'autonomous', maxSteps: 2, decisionDelayMs: 1, directive: 'test' });
    const raw = readDecisions(tmp);
    const written = raw.filter((d) => d.type === 'reflection_memory_written');
    assert.ok(written.length >= 1, 'reflection memory write recorded');
    const w = written[0];
    assert.strictEqual(w.kind, 'semantic');
    assert.match(w.memoryId, /^sem_\d+$/);
    assert.strictEqual(w.memoryId, semanticStore[0].id, 'telemetry ID is the actual returned store ID');
    assert.ok(w.subject.length <= 80);
    // The written memory should then be retrievable in later turns.
    assert.ok(semanticStore.some((m) => m.id === w.memoryId));
    stubBehavior.executeNextStep = async () => ({ ok: true });
  } finally {
    delete process.env.MEMORY_DIR;
    delete process.env.LOG_DIR;
  }
});
