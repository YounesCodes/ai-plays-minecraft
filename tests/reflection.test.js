'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { validateReflection, parseReflectionResponse, shouldReflect } = require('../src/agent/reflection');

test('valid memory proposal accepted', () => {
  const res = validateReflection({
    summary: 'Mining diamond ore with a stone pickaxe produced no diamond.',
    lesson: 'Use a stronger pickaxe.',
    storeSemanticMemory: true,
    semanticMemory: { subject: 'diamond_ore', content: 'Stone pickaxes are insufficient for diamond drops.', confidence: 0.8 },
    storeEpisodicMemory: false,
    changeGoal: true,
    suggestedGoal: 'Obtain an iron pickaxe',
  });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.value.semanticMemory.subject, 'diamond_ore');
  assert.strictEqual(res.value.suggestedGoal, 'Obtain an iron pickaxe');
});

test('malformed memory rejected', () => {
  assert.strictEqual(validateReflection({ summary: '' }).ok, false);
  assert.strictEqual(validateReflection({
    summary: 'x', storeSemanticMemory: true, semanticMemory: { subject: '', content: '' },
  }).ok, false);
  assert.strictEqual(validateReflection({
    summary: 'x', changeGoal: true, suggestedGoal: '',
  }).ok, false);
});

test('code/shell fields rejected', () => {
  assert.strictEqual(validateReflection({ summary: 'x', code: 'evil()' }).ok, false);
  assert.strictEqual(validateReflection({
    summary: 'x', storeSemanticMemory: true,
    semanticMemory: { subject: 'a', content: 'b', exec: 'rm' },
  }).ok, false);
});

test('parseReflectionResponse handles fences and garbage', () => {
  const good = parseReflectionResponse('```json\n{"summary":"died to creeper","lesson":"retreat"}\n```');
  assert.strictEqual(good.ok, true);
  assert.strictEqual(parseReflectionResponse('no json here').ok, false);
});

test('shouldReflect triggers on meaningful events only', () => {
  assert.strictEqual(shouldReflect({ type: 'death' }), true);
  assert.strictEqual(shouldReflect({ type: 'skill_failure' }), true);
  assert.strictEqual(shouldReflect({ type: 'valuable_discovery' }), true);
  assert.strictEqual(shouldReflect({ type: 'routine_wait' }), false);
  assert.strictEqual(shouldReflect({}), false);
});
