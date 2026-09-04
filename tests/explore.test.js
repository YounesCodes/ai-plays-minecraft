'use strict';

// Bounded explore primitive: schema, bounds, abort, stall, displacement.

const test = require('node:test');
const assert = require('node:assert');
const { validatePrimitiveCall } = require('../src/safety/primitiveValidator');
const { explore } = require('../src/primitives/exploration');

function mockBot(overrides = {}) {
  return {
    entity: { position: { x: 0, y: 64, z: 0 } },
    pathfinder: {
      goto: async () => {},
      stop: () => {},
      setGoal: () => {},
    },
    clearControlStates: () => {},
    findBlock: () => null,
    ...overrides,
  };
}

test('explore schema accepts distance and compass directions', () => {
  assert.strictEqual(validatePrimitiveCall({ primitive: 'explore', args: {} }).ok, true);
  assert.strictEqual(validatePrimitiveCall({ primitive: 'explore', args: { distance: 32 } }).ok, true);
  assert.strictEqual(
    validatePrimitiveCall({ primitive: 'explore', args: { distance: 32, direction: 'west' } }).ok,
    true
  );
  assert.strictEqual(validatePrimitiveCall({ primitive: 'explore', args: { distance: 4 } }).ok, false);
  assert.strictEqual(validatePrimitiveCall({ primitive: 'explore', args: { distance: 200 } }).ok, false);
  assert.strictEqual(
    validatePrimitiveCall({ primitive: 'explore', args: { direction: 'up' } }).ok,
    false
  );
});

test('explore travels and reports displacement', async () => {
  const bot = mockBot({
    pathfinder: {
      goto: async () => {
        bot.entity.position.x += 20;
      },
      stop: () => {},
      setGoal: () => {},
    },
  });
  const res = await explore(bot, { distance: 32, direction: 'east' }, { timeoutMs: 10000 });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.direction, 'east');
  assert.strictEqual(res.requestedDistance, 32);
  assert.strictEqual(res.distanceMoved, 20);
  assert.deepStrictEqual(res.startPosition, { x: 0, y: 64, z: 0 });
  assert.strictEqual(res.endPosition.x, 20);
});

test('explore aborts on interrupt', async () => {
  const bot = mockBot({
    pathfinder: {
      goto: () => new Promise(() => {}),
      stop: () => {},
      setGoal: () => {},
    },
  });
  let polls = 0;
  const res = await explore(
    bot,
    { distance: 32 },
    {
      timeoutMs: 30000,
      shouldAbort: () => {
        polls += 1;
        return polls >= 2 ? { type: 'immediate_threat', reason: 'creeper' } : null;
      },
    }
  );
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.aborted, true);
});

test('explore fails honestly when every waypoint stalls', async () => {
  const bot = mockBot({
    pathfinder: {
      goto: () => new Promise(() => {}), // hangs; stall watch fires
      stop: () => {},
      setGoal: () => {},
    },
  });
  const prev = process.env.MOVEMENT_STALL_WINDOW_MS;
  process.env.MOVEMENT_STALL_WINDOW_MS = '1000';
  try {
    const res = await explore(bot, { distance: 8, direction: 'north' }, { timeoutMs: 30000 });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'explore_failed');
    assert.strictEqual(typeof res.distanceMoved, 'number');
  } finally {
    if (prev === undefined) delete process.env.MOVEMENT_STALL_WINDOW_MS;
    else process.env.MOVEMENT_STALL_WINDOW_MS = prev;
  }
});
