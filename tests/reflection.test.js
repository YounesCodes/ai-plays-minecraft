'use strict';

// Reflection-v2: { summary, lesson, memory|null }. No goal changes, no skill
// revisions, at most one memory — the old rich contract failed live ~30%.

const test = require('node:test');
const assert = require('node:assert');
const { validateReflection, parseReflectionResponse, shouldReflect, REFLECTION_CONTRACT } = require('../src/agent/reflection');

test('contract tag present', () => {
  assert.strictEqual(REFLECTION_CONTRACT, 'reflection-v2');
});

test('lesson-only reflection accepted', () => {
  const res = validateReflection({ summary: 'Broke 3 oak logs.', lesson: 'Low trunks first.', memory: null });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.value.memory, null);
});

test('single semantic memory accepted', () => {
  const res = validateReflection({
    summary: 'Mining diamond ore with a stone pickaxe produced no diamond.',
    lesson: 'Use a stronger pickaxe.',
    memory: { kind: 'semantic', subject: 'diamond_ore', content: 'Stone pickaxes are insufficient for diamond drops.', confidence: 0.8 },
  });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.value.memory.subject, 'diamond_ore');
});

test('single episodic memory accepted', () => {
  const res = validateReflection({
    summary: 'Died to a creeper at night.',
    lesson: 'Retreat.',
    memory: { kind: 'episodic', summary: 'Creeper death', lesson: 'Light the area.' },
  });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.value.memory.kind, 'episodic');
});

test('obsolete rich fields rejected', () => {
  for (const extra of ['storeSemanticMemory', 'semanticMemory', 'changeGoal', 'suggestedGoal', 'reviseSkill', 'proposeSkill', 'foo']) {
    const res = validateReflection({ summary: 'x', lesson: 'y', memory: null, [extra]: extra === 'suggestedGoal' ? 'g' : true });
    assert.strictEqual(res.ok, false, extra);
    assert.match(res.error, /Unexpected reflection field/);
  }
});

test('malformed memory rejected, bounds enforced', () => {
  assert.strictEqual(validateReflection({ summary: '' }).ok, false);
  assert.strictEqual(validateReflection({ summary: 'x'.repeat(501) }).ok, false);
  assert.strictEqual(validateReflection({ summary: 'x', memory: { kind: 'weird' } }).ok, false);
  assert.strictEqual(validateReflection({ summary: 'x', memory: { kind: 'semantic', subject: 'a'.repeat(121), content: 'b' } }).ok, false);
});

test('present-but-textless memory downgrades to null (null-intent)', () => {
  // Live models send {}-ish memory objects instead of null when nothing is
  // worth storing; the lesson must survive and no memory is written.
  const a = validateReflection({ summary: 'x', lesson: 'y', memory: { kind: 'episodic', summary: '', lesson: '' } });
  assert.strictEqual(a.ok, true);
  assert.strictEqual(a.value.memory, null);
  const b = validateReflection({ summary: 'x', memory: { kind: 'semantic', subject: '  ', content: '' } });
  assert.strictEqual(b.ok, true);
  assert.strictEqual(b.value.memory, null);
});

test('code/shell fields rejected', () => {
  assert.strictEqual(validateReflection({ summary: 'x', code: 'evil()' }).ok, false);
  assert.strictEqual(validateReflection({
    summary: 'x', memory: { kind: 'semantic', subject: 'a', content: 'b', exec: 'rm' },
  }).ok, false);
});

test('parseReflectionResponse handles fences and garbage', () => {
  const good = parseReflectionResponse('```json\n{"summary":"died to creeper","lesson":"retreat","memory":null}\n```');
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
