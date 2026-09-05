'use strict';

// Pure tests for the model A/B eval harness: scenario contexts build from
// the REAL buildContext, the classifier flags invented skills / knowledge
// lookups / non-canonical items, and no scenario leaks forbidden fields.
// No network, no LLM.

const test = require('node:test');
const assert = require('node:assert');

const { SCENARIOS, classifyStep, buildContextFor, canonicalExists, KNOWLEDGE_PRIMITIVES } = require('../scripts/eval-model-harness.cjs');
const { PRIMITIVE_NAMES } = require('../src/safety/primitiveValidator');

test('eval harness defines the eight required scenarios', () => {
  assert.deepStrictEqual(SCENARIOS.map((s) => s.id), ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
});

test('scenario contexts use the real buildContext and stay bounded', () => {
  for (const sc of SCENARIOS) {
    const ctx = buildContextFor(sc);
    assert.ok(ctx.currentGoal && typeof ctx.currentGoal.description === 'string', `${sc.id} needs a currentGoal`);
    assert.ok(!('curriculum' in ctx), `${sc.id} must not carry curriculum context`);
    const s = JSON.stringify(ctx);
    assert.ok(s.length < 20000, `${sc.id} context too large: ${s.length}`);
    assert.ok(!/api[_-]?key|authorization/i.test(s), `${sc.id} context must not contain credential material`);
  }
});

test('classifier flags invented skills, inventions, and knowledge lookups', () => {
  const invented = classifyStep({ type: 'skill', name: 'craft_pickaxe' }, [], true);
  assert.strictEqual(invented.inventedSkill, true);
  const known = classifyStep({ type: 'skill', name: 'collect_logs' }, ['collect_logs'], true);
  assert.strictEqual(known.legalSkillUse, true);
  assert.strictEqual(known.inventedSkill, undefined);
  const legal = classifyStep({ type: 'primitive', name: 'craft_item', args: { item: 'wooden_pickaxe' } }, [], true);
  assert.strictEqual(legal.legalPrimitiveUse, true);
  assert.strictEqual(legal.itemArg, 'wooden_pickaxe');
  const knowledge = classifyStep({ type: 'primitive', name: 'search_game_data', args: { query: 'pickaxe' } }, [], true);
  assert.strictEqual(knowledge.knowledgeLookup, 'search_game_data');
  const nonCanonical = classifyStep({ type: 'primitive', name: 'craft_item', args: { item: 'wood_pickaxe' } }, [], true);
  assert.strictEqual(nonCanonical.nonCanonicalItem, 'wood_pickaxe');
  const invalid = classifyStep({ type: 'primitive', name: 'mine_stone' }, [], false);
  assert.strictEqual(invalid.inventedPrimitive, true);
  assert.strictEqual(invalid.valid, false);
});

test('canonical checker agrees with installed minecraft-data', () => {
  assert.strictEqual(canonicalExists('wooden_pickaxe'), true);
  assert.strictEqual(canonicalExists('stone'), true);
  assert.strictEqual(canonicalExists('raft'), false);
  assert.strictEqual(canonicalExists('wood_pickaxe'), false);
});

test('knowledge primitive set matches the registered knowledge primitives', () => {
  for (const k of KNOWLEDGE_PRIMITIVES) {
    assert.ok(PRIMITIVE_NAMES.includes(k), `${k} must be a registered primitive`);
  }
});

test('scenario E carries unknown-skill validator feedback in context', () => {
  const sc = SCENARIOS.find((s) => s.id === 'E');
  const ctx = buildContextFor(sc);
  const s = JSON.stringify(ctx);
  assert.ok(s.includes('craft_pickaxe'), 'rejected skill name must appear in context');
  assert.ok(s.includes('Unknown skill'), 'validator feedback must appear in lastResult');
});

test('scenario G provides a real recipe result to act on', () => {
  const sc = SCENARIOS.find((s) => s.id === 'G');
  const ctx = buildContextFor(sc);
  const s = JSON.stringify(ctx);
  assert.ok(s.includes('lookup_recipe'), 'recipe result must appear in lastResult');
  assert.ok(s.includes('requiresTable'), 'recipe result must carry variant detail');
});
