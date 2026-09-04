'use strict';

// Context builder: survival derivation from current perception plus
// exploration/death-signal passthrough. Guards stale-memory-over-observation
// regressions at the unit level.

const test = require('node:test');
const assert = require('node:assert');
const { buildContext, summarizeSurvival } = require('../src/agent/context');

function perception(overrides = {}) {
  return {
    self: { health: 20, food: 20 },
    inventory: {},
    environment: { timeCategory: 'day' },
    nearbyEntitiesDetailed: [],
    interestingBlocks: [],
    knownLocationsNearby: [],
    ...overrides,
  };
}

test('survival snapshot flags unarmed nights with nearby hostiles', () => {
  const s = summarizeSurvival(
    perception({
      inventory: { oak_log: 4 },
      environment: { timeCategory: 'night' },
      nearbyEntitiesDetailed: [{ type: 'zombie', distance: 5.2, hostile: true }],
    })
  );
  assert.strictEqual(s.unarmed, true);
  assert.strictEqual(s.night, true);
  assert.deepStrictEqual(s.nearestHostile, { type: 'zombie', distance: 5.2 });
});

test('survival snapshot recognizes weapons and food', () => {
  const s = summarizeSurvival(
    perception({
      inventory: { stone_sword: 1, bread: 2 },
      environment: { timeCategory: 'day' },
      nearbyEntitiesDetailed: [{ type: 'cow', distance: 6, hostile: false }],
    })
  );
  assert.strictEqual(s.unarmed, false);
  assert.strictEqual(s.foodAvailable, true);
  assert.strictEqual(s.night, false);
  assert.strictEqual(s.nearestHostile, null);
});

test('buildContext passes exploration and death signals through', () => {
  const ctx = buildContext({
    directive: 'd',
    goalState: { currentGoal: null, subgoals: [], suspendedGoal: null },
    perception: perception(),
    exploration: { currentCell: '0,0', localSearchExhausted: true },
    deathSignal: { recentDeaths: 3, recentDeathRegion: '0,0', repeatedFailure: 'relocate' },
  });
  assert.strictEqual(ctx.exploration.localSearchExhausted, true);
  assert.strictEqual(ctx.deathSignal.recentDeaths, 3);
  assert.ok(ctx.survival);
});
