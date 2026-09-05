'use strict';

// Workstation anchoring + readiness tests: trusted station memory,
// move_to_known_location, stale healing, recipe status, deferral drift.
// No LLM, no network (mock bots, tmp MEMORY_DIR).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function freshEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'station-test-'));
  process.env.MEMORY_DIR = tmp;
  return tmp;
}

function clearEnv() {
  delete process.env.MEMORY_DIR;
}

function worldMod() {
  delete require.cache[require.resolve('../src/memory/world')];
  return require('../src/memory/world');
}

test('placement records trusted station position', () => {
  freshEnv();
  try {
    const world = worldMod();
    const { anchorWorkstationFromResult } = require('../src/agent/loop');
    const bot = { game: { dimension: 'overworld' } };
    anchorWorkstationFromResult({
      result: { ok: true, primitive: 'place_block_nearby', item: 'crafting_table', position: { x: 10, y: 64, z: 20 } },
      bot,
      step: 5,
    });
    const entry = world.get('crafting_station');
    assert.ok(entry, 'station remembered');
    assert.deepStrictEqual(entry.position, { x: 10, y: 64, z: 20 });
    assert.strictEqual(entry.metadata.kind, 'workstation');
    assert.strictEqual(entry.metadata.block, 'crafting_table');
    assert.strictEqual(entry.metadata.source, 'trusted_placement');
  } finally {
    clearEnv();
  }
});

test('failed placement records nothing; LLM text never becomes coordinates', () => {
  freshEnv();
  try {
    const world = worldMod();
    const { anchorWorkstationFromResult } = require('../src/agent/loop');
    const bot = { game: { dimension: 'overworld' } };
    anchorWorkstationFromResult({
      result: { ok: false, primitive: 'place_block_nearby', item: 'crafting_table', error: 'no surface' },
      bot,
      step: 5,
    });
    assert.strictEqual(world.get('crafting_station'), null);
  } finally {
    clearEnv();
  }
});

test('successful table craft refreshes station position', () => {
  freshEnv();
  try {
    const world = worldMod();
    const { anchorWorkstationFromResult } = require('../src/agent/loop');
    const bot = { game: { dimension: 'overworld' } };
    anchorWorkstationFromResult({
      result: { ok: true, primitive: 'craft_item', item: 'wooden_pickaxe', crafted: 1, craftingTablePosition: { x: 30, y: 64, z: 40 } },
      bot,
      step: 9,
    });
    const entry = world.get('crafting_station');
    assert.ok(entry);
    assert.deepStrictEqual(entry.position, { x: 30, y: 64, z: 40 });
    assert.strictEqual(entry.metadata.source, 'trusted_use');
  } finally {
    clearEnv();
  }
});

test('known-location observation exposes safe kind/block/distance', () => {
  const { observe } = require('../src/bot/observations');
  const bot = {
    health: 20, food: 20,
    entity: { position: { x: 0, y: 64, z: 0 } },
    game: { dimension: 'overworld' },
    time: { timeOfDay: 6000 },
    inventory: { items: () => [], slots: [] },
    entities: {},
    blockAt: () => null,
    findBlocks: () => [],
  };
  const worldMemory = {
    list: () => [{ name: 'crafting_station', position: { x: 3, y: 64, z: 4 }, metadata: { kind: 'workstation', block: 'crafting_table' } }],
  };
  const obs = observe(bot, { worldMemory });
  const found = (obs.knownLocationsNearby || []).find((e) => e.name === 'crafting_station');
  assert.ok(found);
  assert.strictEqual(found.kind, 'workstation');
  assert.strictEqual(found.block, 'crafting_table');
  assert.ok(found.distance > 0 && found.distance < 10);
  assert.ok(!('metadata' in found), 'full memory object must not leak');
});

test('move_to_known_location rejects unknown names', async () => {
  freshEnv();
  try {
    worldMod();
    const { moveToKnownLocation } = require('../src/primitives/movement');
    const bot = { entity: { position: { x: 0, y: 64, z: 0 } }, game: { dimension: 'overworld' } };
    const res = await moveToKnownLocation(bot, { name: 'nope_nowhere' }, {});
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /Unknown location/);
  } finally {
    clearEnv();
  }
});

test('move_to_known_location rejects dimension mismatch', async () => {
  freshEnv();
  try {
    const world = worldMod();
    world.remember('nether_gate', { x: 0, y: 64, z: 0 }, { kind: 'portal' }, 'the_nether');
    const { moveToKnownLocation } = require('../src/primitives/movement');
    const bot = { entity: { position: { x: 0, y: 64, z: 0 } }, game: { dimension: 'overworld' } };
    const res = await moveToKnownLocation(bot, { name: 'nether_gate' }, {});
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /another dimension/);
  } finally {
    clearEnv();
  }
});

test('move_to_known_location uses hardened movement and reports distances', async () => {
  freshEnv();
  try {
    const world = worldMod();
    world.remember('cache', { x: 10, y: 64, z: 0 }, { kind: 'cache' }, 'overworld');
    const { moveToKnownLocation } = require('../src/primitives/movement');
    const bot = {
      entity: { position: { x: 0, y: 64, z: 0 } },
      game: { dimension: 'overworld' },
      pathfinder: {
        goto: async function () {
          bot.entity.position = { x: 9, y: 64, z: 0 };
        },
        stop: () => {},
        setGoal: () => {},
      },
      clearControlStates: () => {},
    };
    const res = await moveToKnownLocation(bot, { name: 'cache', range: 4 }, { timeoutMs: 5000 });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.name, 'cache');
    assert.ok(typeof res.distanceMoved === 'number');
    assert.ok(typeof res.finalDistance === 'number' && res.finalDistance <= 4);
  } finally {
    clearEnv();
  }
});

test('stale station is invalidated on arrival without false claims', async () => {
  freshEnv();
  try {
    const world = worldMod();
    world.remember('crafting_station', { x: 10, y: 64, z: 0 }, { kind: 'workstation', block: 'crafting_table', source: 'trusted_placement' }, 'overworld');
    const { moveToKnownLocation } = require('../src/primitives/movement');
    const bot = {
      entity: { position: { x: 0, y: 64, z: 0 } },
      game: { dimension: 'overworld' },
      findBlock: () => null, // nothing observable: stale
      pathfinder: {
        goto: async function () {
          bot.entity.position = { x: 9, y: 64, z: 0 };
        },
        stop: () => {},
        setGoal: () => {},
      },
      clearControlStates: () => {},
    };
    const res = await moveToKnownLocation(bot, { name: 'crafting_station', range: 4 }, { timeoutMs: 5000 });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.stationStale, true);
    assert.strictEqual(world.get('crafting_station'), null);
  } finally {
    clearEnv();
  }
});

test('recipe status: missing, ready, tableNearby, knownStation', () => {
  const { recipeStatus } = require('../src/curriculum/manager');
  const state = {
    inventory: { oak_planks: 5 },
    nearbyBlocks: [{ type: 'crafting_table', distance: 3.1 }],
    session: {},
    mcVersion: '1.21.11',
    worldLocations: [{ name: 'crafting_station', position: { x: 100, y: 64, z: 100 }, metadata: { kind: 'workstation' } }],
    botPosition: { x: 0, y: 64, z: 0 },
  };
  // Wooden pickaxe needs planks+sticks; sticks missing here.
  const s = recipeStatus('craft_wooden_pickaxe', state);
  assert.ok(s);
  assert.strictEqual(s.materialsReady, false);
  assert.ok(s.missing.stick >= 1);
  assert.strictEqual(s.requiresTable, true);
  assert.strictEqual(s.tableNearby, true);
  assert.strictEqual(s.knownStation.name, 'crafting_station');
  // Ready case: sticks present too.
  const ready = recipeStatus('craft_wooden_pickaxe', { ...state, inventory: { oak_planks: 5, stick: 4 } });
  assert.strictEqual(ready.materialsReady, true);
  assert.deepStrictEqual(ready.missing, {});
  // Non-craft milestone -> null.
  assert.strictEqual(recipeStatus('obtain_logs', state), null);
});

test('craftableMissing finds one-level intermediates from real data', () => {
  const { recipeStatus } = require('../src/curriculum/manager');
  const s = recipeStatus('craft_wooden_pickaxe', {
    inventory: { oak_planks: 5 },
    nearbyBlocks: [],
    session: {},
    mcVersion: '1.21.11',
    worldLocations: [],
    botPosition: null,
  });
  assert.strictEqual(s.materialsReady, false);
  assert.ok(s.craftableMissing.some((c) => c.item === 'stick' && c.canCraftNow === true));
});

test('deferral counter: triggers on repeated non-progress, resets properly', () => {
  const { updateReadinessDrift, driftForContext } = require('../src/agent/loop');
  const status = { id: 'craft_wooden_pickaxe', status: { materialsReady: true, requiresTable: true } };
  let d = { milestoneId: null, count: 0 };
  d = updateReadinessDrift({ drift: d, status, nextStep: { type: 'primitive', name: 'mine_block_type', args: {} }, emergency: false });
  assert.strictEqual(d.count, 1);
  assert.strictEqual(driftForContext(d).detected, false);
  d = updateReadinessDrift({ drift: d, status, nextStep: { type: 'primitive', name: 'explore', args: {} }, emergency: false });
  assert.strictEqual(d.count, 2);
  assert.strictEqual(driftForContext(d).detected, true);
  assert.strictEqual(driftForContext(d).milestone, 'craft_wooden_pickaxe');
  // Crafting resets.
  d = updateReadinessDrift({ drift: d, status, nextStep: { type: 'primitive', name: 'craft_item', args: {} }, emergency: false });
  assert.strictEqual(d.count, 0);
  // Emergency resets/ignores.
  d = updateReadinessDrift({ drift: { milestoneId: 'craft_wooden_pickaxe', count: 2 }, status, nextStep: { type: 'primitive', name: 'explore', args: {} }, emergency: true });
  assert.strictEqual(d.count, 0);
  // Milestone change resets (fresh count for the new milestone).
  const other = { id: 'obtain_cobblestone', status: { materialsReady: true } };
  d = updateReadinessDrift({ drift: { milestoneId: 'craft_wooden_pickaxe', count: 2 }, status: other, nextStep: { type: 'primitive', name: 'explore', args: {} }, emergency: false });
  assert.strictEqual(d.count, 0);
  assert.strictEqual(d.milestoneId, 'obtain_cobblestone');
  d = updateReadinessDrift({ drift: d, status: other, nextStep: { type: 'primitive', name: 'explore', args: {} }, emergency: false });
  assert.strictEqual(d.count, 1);
});
