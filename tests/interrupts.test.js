'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { detectInterrupts, isUrgent } = require('../src/bot/interrupts');

function perception({ health = 20, food = 20, entities = [], onFire = false } = {}) {
  return {
    self: { health, food, onFire, underwater: false },
    health, food,
    nearbyEntitiesDetailed: entities,
  };
}

test('critical health generates interrupt', () => {
  const found = detectInterrupts(perception({ health: 5 }));
  assert.ok(found.some((i) => i.type === 'critical_health'));
  assert.ok(isUrgent(found[0]));
});

test('nearby hostile generates interrupt according to threshold', () => {
  const close = detectInterrupts(perception({ entities: [{ type: 'creeper', distance: 3, hostile: true, id: 37 }] }));
  assert.ok(close.some((i) => i.type === 'immediate_threat'));
  const far = detectInterrupts(
    perception({ entities: [{ type: 'creeper', distance: 50, hostile: true, id: 38 }] }),
    {},
    { criticalHealth: 8, lowHealth: 12, criticalFood: 6, hostileVeryClose: 5, hostileClose: 10 }
  );
  assert.ok(!far.some((i) => i.type === 'immediate_threat'));
});

test('non-dangerous entity does not generate urgent interrupt', () => {
  const found = detectInterrupts(perception({ entities: [{ type: 'cow', distance: 2, hostile: false, id: 9 }] }));
  assert.ok(!found.some((i) => isUrgent(i)));
});

test('death and fire detected', () => {
  assert.ok(detectInterrupts(perception({ health: 0 }), { death: true }).some((i) => i.type === 'death'));
  assert.ok(detectInterrupts(perception({ onFire: true })).some((i) => i.type === 'on_fire'));
});

test('critical hunger detected', () => {
  assert.ok(detectInterrupts(perception({ food: 3 })).some((i) => i.type === 'critical_hunger'));
});
