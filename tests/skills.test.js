'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { validateSkill } = require('../src/safety/skillValidator');
const { executeSkill } = require('../src/skills/executor');
const { parseSkillResponse } = require('../src/skills/generator');

function validSkill() {
  return {
    id: 'fight-creeper-carefully',
    name: 'fight_creeper_carefully',
    description: 'Hit a creeper and create distance before it explodes.',
    parameters: ['targetEntityId'],
    steps: [
      { primitive: 'equip_best_melee_weapon', args: {} },
      { primitive: 'move_near_entity', args: { entityId: '$targetEntityId', distance: 2.8 } },
      { primitive: 'attack_entity', args: { entityId: '$targetEntityId' } },
      { primitive: 'move_away_from_entity', args: { entityId: '$targetEntityId', distance: 7 } },
    ],
  };
}

test('valid declarative skill passes', () => {
  assert.strictEqual(validateSkill(validSkill()).ok, true);
});

test('unknown primitive rejected', () => {
  const s = validSkill();
  s.steps[0] = { primitive: 'fly', args: {} };
  assert.strictEqual(validateSkill(s).ok, false);
});

test('too many steps rejected', () => {
  const s = validSkill();
  s.steps = Array.from({ length: 30 }, () => ({ primitive: 'wait', args: { seconds: 1 } }));
  assert.strictEqual(validateSkill(s, { maxSteps: 12 }).ok, false);
});

test('malformed parameter rejected', () => {
  const s = validSkill();
  s.parameters = ['bad-param!'];
  assert.strictEqual(validateSkill(s).ok, false);
});

test('code/command fields rejected', () => {
  const s = validSkill();
  s.steps[0] = { primitive: 'wait', args: { seconds: 1 }, code: 'evil()' };
  assert.strictEqual(validateSkill(s).ok, false);
  const s2 = validSkill();
  s2.steps[0] = { primitive: 'chat', args: { message: 'hi', command: 'rm' } };
  assert.strictEqual(validateSkill(s2).ok, false);
});

test('nested executable payload rejected', () => {
  const s = validSkill();
  s.steps[0] = { primitive: 'wait', args: { seconds: { valueOf: 1 } } };
  assert.strictEqual(validateSkill(s).ok, false);
});

test('recursion/nested skill rejected', () => {
  const s = validSkill();
  s.steps.push({ primitive: 'wait', args: { seconds: 1 }, skill: 'other' });
  assert.strictEqual(validateSkill(s).ok, false);
});

test('unknown parameter reference rejected', () => {
  const s = validSkill();
  s.steps[1] = { primitive: 'move_near_entity', args: { entityId: '$nope', distance: 3 } };
  assert.strictEqual(validateSkill(s).ok, false);
});

test('executor runs ordered primitives with param substitution', async () => {
  const calls = [];
  const bot = {
    health: 20,
    food: 20,
    inventory: { items: () => [] },
    chat: (m) => calls.push(m),
  };
  const skill = {
    id: 's1',
    name: 'say_twice',
    description: 'Send two chats.',
    parameters: ['word'],
    steps: [
      { primitive: 'chat', args: { message: '$word' } },
      { primitive: 'wait', args: { seconds: 1 } },
    ],
  };
  // Avoid real 1s wait: monkey-patch not needed; 1s is acceptable in tests.
  const res = await executeSkill(bot, skill, { word: 'hello' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.completedSteps, 2);
  assert.deepStrictEqual(calls, ['hello']);
  assert.ok(typeof res.durationMs === 'number');
});

test('executor stops on first failure and reports', async () => {
  const bot = { health: 20, food: 20, inventory: { items: () => [] }, chat: () => {} };
  const skill = {
    id: 's2',
    name: 'fail_fast',
    description: 'First step fails.',
    parameters: [],
    steps: [
      { primitive: 'attack_entity', args: { entityId: 99999 } },
      { primitive: 'chat', args: { message: 'never' } },
    ],
  };
  const res = await executeSkill(bot, skill, {});
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.completedSteps, 0);
  assert.strictEqual(res.failedStep, 0);
});

test('executor aborts on interrupt', async () => {
  const bot = {
    health: 20, food: 20,
    inventory: { items: () => [] },
    chat: () => {},
  };
  const skill = {
    id: 's3',
    name: 'abort_me',
    description: 'Aborted skill.',
    parameters: [],
    steps: [
      { primitive: 'chat', args: { message: 'one' } },
      { primitive: 'chat', args: { message: 'two' } },
    ],
  };
  let calls = 0;
  const res = await executeSkill(bot, skill, {}, {
    shouldAbort: () => {
      calls += 1;
      return calls >= 2 ? { type: 'immediate_threat', priority: 95, reason: 'creeper' } : null;
    },
  });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.aborted, true);
});

test('generator parses and validates skill JSON', () => {
  const text = JSON.stringify(validSkill());
  const parsed = parseSkillResponse(text);
  assert.strictEqual(parsed.ok, true);
  const bad = parseSkillResponse('not json at all');
  assert.strictEqual(bad.ok, false);
});
