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
