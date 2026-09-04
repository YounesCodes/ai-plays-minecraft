'use strict';

// Version-gated 1.21.x collision workaround: applies only in range, only on
// stock values, never twice, never without bot.physics.

const test = require('node:test');
const assert = require('node:assert');
const {
  applyPathfinderCompat,
  supported,
  alreadyApplied,
} = require('../src/bot/pathfinderCompat');

test('supported() covers only the known-affected 1.21.x range', () => {
  assert.strictEqual(supported('1.21.11'), true);
  assert.strictEqual(supported('1.21.9'), true);
  assert.strictEqual(supported('1.21.10'), true);
  assert.strictEqual(supported('1.21.8'), false);
  assert.strictEqual(supported('1.20.4'), false);
  assert.strictEqual(supported(undefined), false);
  assert.strictEqual(supported('1.22'), false);
});

test('applyPathfinderCompat bumps stock physics once and only once', () => {
  const bot = { physics: { playerHalfWidth: 0.3, playerHeight: 1.8 } };
  assert.strictEqual(applyPathfinderCompat(bot, '1.21.11'), true);
  assert.strictEqual(bot.physics.playerHalfWidth, 0.30001);
  assert.strictEqual(bot.physics.playerHeight, 1.80001);
  assert.strictEqual(alreadyApplied(bot), true);
  assert.strictEqual(applyPathfinderCompat(bot, '1.21.11'), true);
  assert.strictEqual(bot.physics.playerHalfWidth, 0.30001);
});

test('applyPathfinderCompat refuses out-of-range versions and odd state', () => {
  const old = { physics: { playerHalfWidth: 0.3, playerHeight: 1.8 } };
  assert.strictEqual(applyPathfinderCompat(old, '1.21.8'), false);
  assert.deepStrictEqual(old.physics, { playerHalfWidth: 0.3, playerHeight: 1.8 });

  const weird = { physics: { playerHalfWidth: 0.5, playerHeight: 2 } };
  assert.strictEqual(applyPathfinderCompat(weird, '1.21.11'), false);
  assert.deepStrictEqual(weird.physics, { playerHalfWidth: 0.5, playerHeight: 2 });

  assert.strictEqual(applyPathfinderCompat({}, '1.21.11'), false);
  assert.strictEqual(applyPathfinderCompat(null, '1.21.11'), false);
});
