'use strict';

// Staged mining feedback: blockBroken vs dropSpawned vs dropCollected vs
// toolWasSuitable. Guards the false lesson "iron pickaxes don't work on
// diamonds" when a drop merely sat uncollected.

const test = require('node:test');
const assert = require('node:assert');
const { mineBlock, mineBlockType } = require('../src/primitives/mining');

function baseBot(overrides = {}) {
  return {
    inventory: { items: () => [] },
    entities: {},
    ...overrides,
  };
}

test('mineBlock reports full success when the drop lands in inventory', async () => {
  const inv = [];
  const bot = baseBot({
    inventory: { items: () => inv.slice() },
    entities: {},
    blockAt: () => ({ name: 'diamond_ore', position: { x: 1, y: 2, z: 3 } }),
    heldItem: { name: 'iron_pickaxe' },
    dig: async () => {
      inv.push({ name: 'diamond', count: 1 });
      bot.entities[7] = { position: { x: 1.2, y: 2, z: 3 } };
    },
  });

  const res = await mineBlock(bot, { x: 1, y: 2, z: 3 }, {});
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.blockBroken, true);
  assert.strictEqual(res.expectedDrop, 'diamond');
  assert.strictEqual(res.dropSpawned, true);
  assert.strictEqual(res.dropCollected, true);
  assert.strictEqual(res.toolWasSuitable, true);
});

test('mineBlock blames the tool only when no drop spawned', async () => {
  const bot = baseBot({
    blockAt: () => ({ name: 'diamond_ore', position: { x: 1, y: 2, z: 3 } }),
    heldItem: { name: 'wooden_pickaxe' },
    dig: async () => {},
  });

  const res = await mineBlock(bot, { x: 1, y: 2, z: 3 }, {});
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.blockBroken, true);
  assert.strictEqual(res.dropSpawned, false);
  assert.strictEqual(res.dropCollected, false);
  assert.strictEqual(res.toolWasSuitable, false);
  assert.match(res.error, /unsuitable/);
});

test('mineBlock reports uncollected drop without blaming the tool', async () => {
  const bot = baseBot({
    blockAt: () => ({ name: 'diamond_ore', position: { x: 1, y: 2, z: 3 } }),
    heldItem: { name: 'iron_pickaxe' },
    dig: async () => {
      bot.entities[9] = { position: { x: 1.2, y: 2, z: 3 } };
    },
  });

  const res = await mineBlock(bot, { x: 1, y: 2, z: 3 }, {});
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.blockBroken, true);
  assert.strictEqual(res.dropSpawned, true);
  assert.strictEqual(res.dropCollected, false);
  assert.strictEqual(res.toolWasSuitable, null);
  assert.match(res.error, /ground nearby/);
});

test('mineBlockType finds blocks by type name (predicate matching)', async () => {
  // The mock only honors function matchers, like real Mineflayer: passing
  // the raw name string (the old bug) throws here and finds nothing.
  const inv = [];
  const bot = baseBot({
    inventory: { items: () => inv.slice() },
    entities: {},
    findBlock: ({ matching }) => {
      if (typeof matching !== 'function') throw new Error('string matching unsupported');
      const b = { name: 'oak_log', position: { x: 1, y: 2, z: 3 } };
      return matching(b) ? b : null;
    },
    dig: async () => {
      inv.push({ name: 'oak_log', count: 2 });
    },
  });

  const res = await mineBlockType(bot, { blockType: 'oak_log', count: 2 }, {});
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.broken, 2);
  assert.strictEqual(res.dropObtained, true);
});
test('mineBlock aborts before digging when an interrupt is pending', async () => {
  let dug = false;
  const bot = baseBot({
    blockAt: () => ({ name: 'stone', position: { x: 1, y: 2, z: 3 } }),
    dig: async () => {
      dug = true;
    },
  });

  const res = await mineBlock(bot, { x: 1, y: 2, z: 3 }, { shouldAbort: () => ({ type: 'immediate_threat' }) });
  assert.strictEqual(dug, false);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.aborted, true);
});

test('mineBlockType continues past uncollected blocks with per-block detail', async () => {
  const inv = [];
  const bot = baseBot({
    inventory: { items: () => inv.slice() },
    entities: {},
    findBlock: () => ({ name: 'oak_log', position: { x: 1, y: 2, z: 3 } }),
    dig: async () => {
      inv.push({ name: 'oak_log', count: 1 });
    },
  });

  const res = await mineBlockType(bot, { blockType: 'oak_log', count: 2 }, {});
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.broken, 2);
  assert.strictEqual(res.blocks.length, 2);
  assert.ok(res.blocks.every((b) => b.blockBroken));
});

test('mineBlock walks to uncollected log drops and collects them', async () => {
  const inv = [];
  const bot = baseBot({
    inventory: { items: () => inv.slice() },
    entities: {},
    blockAt: () => ({ name: 'oak_log', position: { x: 1, y: 2, z: 3 } }),
    pathfinder: {
      goto: async () => {
        inv.push({ name: 'oak_log', count: 1 });
      },
      stop: () => {},
    },
    dig: async () => {
      bot.entities[5] = { position: { x: 4, y: 2, z: 3 } };
    },
  });

  const res = await mineBlock(bot, { x: 1, y: 2, z: 3 }, {});
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.blockBroken, true);
  assert.strictEqual(res.dropCollected, true);
});

test('mineBlockType fails honestly when nothing is collected', async () => {
  const bot = baseBot({
    inventory: { items: () => [] },
    entities: {},
    findBlock: () => ({ name: 'oak_log', position: { x: 1, y: 2, z: 3 } }),
    dig: async () => {},
  });

  const res = await mineBlockType(bot, { blockType: 'oak_log', count: 2 }, {});
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.broken, 2);
  assert.match(res.error, /collected nothing/);
});

test('mine_block_type skips cached unreachable targets for alternates', async () => {
  const targetFailures = require('../src/navigation/targetFailures');
  targetFailures.clear();
  const inv = [];
  const approached = [];
  const dug = [];
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    game: { dimension: 'minecraft:overworld' },
    inventory: { items: () => inv.slice() },
    entities: {},
    pathfinder: {
      goto: async () => {},
      stop: () => {},
      setGoal: () => {},
    },
    clearControlStates: () => {},
    findBlocks: ({ matching }) => {
      const all = [
        { name: 'oak_log', position: { x: 5, y: 64, z: 5 } },
        { name: 'oak_log', position: { x: 40, y: 64, z: 40 } },
      ];
      return all.filter((b) => matching(b));
    },
    dig: async (block) => {
      dug.push(`${block.position.x},${block.position.z}`);
      inv.push({ name: 'oak_log', count: 1 });
    },
  };
  try {
    // Pre-seed: the near block already proved unreachable from here.
    targetFailures.recordFailure({
      dimension: 'minecraft:overworld',
      kind: 'block',
      target: 'oak_log',
      position: { x: 5, y: 64, z: 5 },
      reason: 'movement_stalled',
      attemptedFrom: { x: 0, y: 64, z: 0 },
    });
    const { mineBlockType } = require('../src/primitives/mining');
    const res = await mineBlockType(bot, { blockType: 'oak_log', count: 1 }, {});
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.broken, 1);
    assert.deepStrictEqual(dug, ['40,40']); // near cached block never re-attempted
  } finally {
    targetFailures.clear();
  }
});

test('mine_block_type reports no_reachable_target vs resource_not_seen', async () => {
  const targetFailures = require('../src/navigation/targetFailures');
  targetFailures.clear();
  const { mineBlockType } = require('../src/primitives/mining');
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    game: { dimension: 'minecraft:overworld' },
    inventory: { items: () => [] },
    entities: {},
    pathfinder: { goto: async () => {}, stop: () => {}, setGoal: () => {} },
    clearControlStates: () => {},
    findBlocks: () => [],
    findBlock: () => null,
    dig: async () => {},
  };
  try {
    const empty = await mineBlockType(bot, { blockType: 'oak_log', count: 1 }, {});
    assert.strictEqual(empty.ok, false);
    assert.strictEqual(empty.reason, 'resource_not_seen');

    bot.findBlocks = () => [{ name: 'oak_log', position: { x: 6, y: 64, z: 6 } }];
    targetFailures.recordFailure({
      dimension: 'minecraft:overworld',
      kind: 'block',
      target: 'oak_log',
      position: { x: 6, y: 64, z: 6 },
      reason: 'timeout',
      attemptedFrom: { x: 0, y: 64, z: 0 },
    });
    const blocked = await mineBlockType(bot, { blockType: 'oak_log', count: 1 }, {});
    assert.strictEqual(blocked.ok, false);
    assert.strictEqual(blocked.reason, 'no_reachable_target');
    assert.strictEqual(blocked.candidatesSeen, 1);
    assert.strictEqual(blocked.candidatesSkipped, 1);
  } finally {
    targetFailures.clear();
  }
});

test('mine_block works when blockAt requires Vec3', async () => {
  const inv = [];
  const bot = baseBot({
    inventory: { items: () => inv.slice() },
    entities: {},
    blockAt: (p) => {
      if (typeof p.floored !== 'function') throw new Error('pos.floored is not a function');
      return { name: 'stone', position: { x: 1, y: 2, z: 3 } };
    },
    dig: async () => {
      inv.push({ name: 'cobblestone', count: 1 });
    },
  });

  const { mineBlock } = require('../src/primitives/mining');
  const res = await mineBlock(bot, { x: 1, y: 2, z: 3 }, {});
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.blockBroken, true);
});

test('craft lookup resolves real item names', async () => {
  const { craftItem } = require('../src/primitives/crafting');
  const unknown = await craftItem({ version: '1.21.11' }, { item: 'not_a_real_item_xyz', count: 1 });
  assert.strictEqual(unknown.ok, false);
  assert.match(unknown.error, /Unknown item/);
  const bot = {
    version: '1.21.11',
    inventory: { items: () => [{ name: 'oak_log', count: 4 }] },
    recipesFor: () => [],
  };
  const noRecipe = await craftItem(bot, { item: 'oak_planks', count: 1 });
  assert.strictEqual(noRecipe.ok, false);
  assert.match(noRecipe.error, /recipe/i);
});
