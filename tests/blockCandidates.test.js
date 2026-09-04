'use strict';

// Regression tests for the real Mineflayer findBlocks contract.
//
// Real Mineflayer (4.38.0, lib/plugins/blocks.js):
//   findBlocks() -> Vec3[]  (positions, sorted by distance)
//   findBlock()  -> Block|null (via blockAt)
// The autonomous code previously treated Vec3 entries as Blocks
// (checking candidate.position), silently discarding every live candidate
// while mocks returned Block objects. These tests use Vec3-shaped values
// as the primary mocked behavior.

const test = require('node:test');
const assert = require('node:assert');
const { Vec3 } = require('vec3');
const {
  findBlockCandidates,
  rankBlockCandidates,
  getSelectableBlocks,
} = require('../src/navigation/blockCandidates');
const targetFailures = require('../src/navigation/targetFailures');

function blockAtFor(map) {
  return (p) => {
    const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
    return map[k] || null;
  };
}

function oakBot(positions, blocksByKey, botPos = new Vec3(0, 64, 0)) {
  return {
    entity: { position: botPos },
    game: { dimension: 'minecraft:overworld' },
    findBlocks: () => positions.slice(),
    blockAt: blockAtFor(blocksByKey),
  };
}

const oakMatch = (b) => !!b && b.name === 'oak_log';

test('Vec3 results never silently disappear: normalized to Blocks', () => {
  const near = new Vec3(2, 64, 0);
  const far = new Vec3(8, 68, 0);
  const bot = oakBot([near, far], {
    '2,64,0': { name: 'oak_log', position: new Vec3(2, 64, 0) },
    '8,68,0': { name: 'oak_log', position: new Vec3(8, 68, 0) },
  });
  const out = findBlockCandidates(bot, { matching: oakMatch, maxDistance: 32, count: 12 });
  assert.strictEqual(out.length, 2);
  assert.ok(out.every((b) => b && typeof b.name === 'string' && b.position));
  assert.strictEqual(out[0].name, 'oak_log');
});

test('null/unloaded candidates are filtered', () => {
  const bot = oakBot([new Vec3(1, 64, 0), new Vec3(2, 64, 0)], {
    '1,64,0': null, // chunk not loaded
    '2,64,0': { name: 'oak_log', position: new Vec3(2, 64, 0) },
  });
  const out = findBlockCandidates(bot, { matching: oakMatch, maxDistance: 16, count: 12 });
  assert.strictEqual(out.length, 1);
  assert.deepStrictEqual(
    { x: out[0].position.x, y: out[0].position.y, z: out[0].position.z },
    { x: 2, y: 64, z: 0 }
  );
});

test('matcher revalidation drops stale blocks', () => {
  const bot = oakBot([new Vec3(3, 64, 0)], {
    '3,64,0': { name: 'dirt', position: new Vec3(3, 64, 0) }, // no longer oak
  });
  const out = findBlockCandidates(bot, { matching: oakMatch, maxDistance: 16, count: 12 });
  assert.strictEqual(out.length, 0);
});

test('duplicate coordinates are deduplicated', () => {
  const bot = oakBot(
    [new Vec3(4, 64, 0), new Vec3(4, 64, 0), { x: 4, y: 64, z: 0 }],
    { '4,64,0': { name: 'oak_log', position: new Vec3(4, 64, 0) } }
  );
  const out = findBlockCandidates(bot, { matching: oakMatch, maxDistance: 16, count: 12 });
  assert.strictEqual(out.length, 1);
});

test('generic ranking prefers in-reach, low, near targets (no tree logic)', () => {
  const botPos = new Vec3(0, 64, 0);
  const mk = (x, y, z) => ({ name: 'oak_log', position: new Vec3(x, y, z) });
  const canopy = mk(3, 72, 0); // 8 above, ~8.5 away
  const nearTrunk = mk(2, 64, 0); // 2 away, same level
  const bot = { entity: { position: botPos } };
  const ranked = rankBlockCandidates(bot, [canopy, nearTrunk]);
  assert.strictEqual(ranked[0], nearTrunk);
  assert.strictEqual(ranked[1], canopy);
});

test('targetFailures exclusion removes stale targets from selection', () => {
  targetFailures.clear();
  try {
    const bot = oakBot(
      [new Vec3(5, 64, 5), new Vec3(40, 64, 40)],
      {
        '5,64,5': { name: 'oak_log', position: new Vec3(5, 64, 5) },
        '40,64,40': { name: 'oak_log', position: new Vec3(40, 64, 40) },
      },
      new Vec3(0, 64, 0)
    );
    targetFailures.recordFailure({
      dimension: 'minecraft:overworld',
      kind: 'block',
      target: 'oak_log',
      position: { x: 5, y: 64, z: 5 },
      reason: 'movement_stalled',
      attemptedFrom: { x: 0, y: 64, z: 0 },
    });
    const sel = getSelectableBlocks(bot, {
      matching: oakMatch, blockType: 'oak_log', maxDistance: 64, count: 12,
      kind: 'block', target: 'oak_log',
    });
    assert.strictEqual(sel.candidatesSeen, 2);
    assert.strictEqual(sel.candidatesSkipped, 1);
    assert.strictEqual(sel.candidates.length, 1);
    assert.deepStrictEqual(
      { x: sel.candidates[0].position.x, z: sel.candidates[0].position.z },
      { x: 40, z: 40 }
    );
  } finally {
    targetFailures.clear();
  }
});

test('adjacent target heals a stale navigation failure', () => {
  targetFailures.clear();
  try {
    // Record failure from far away.
    targetFailures.recordFailure({
      dimension: 'minecraft:overworld',
      kind: 'block',
      target: 'oak_log',
      position: { x: 10, y: 64, z: 10 },
      reason: 'timeout',
      attemptedFrom: { x: 0, y: 64, z: 0 },
    });
    // Same pocket: still excluded.
    const stillOut = targetFailures.isExcluded({
      dimension: 'minecraft:overworld',
      kind: 'block',
      target: 'oak_log',
      position: { x: 10, y: 64, z: 10 },
      fromPosition: { x: 1, y: 64, z: 1 },
    });
    assert.ok(stillOut, 'far-away failure still excludes near origin');
    // Bot walks adjacent: heal, target selectable again.
    const healed = targetFailures.isExcluded({
      dimension: 'minecraft:overworld',
      kind: 'block',
      target: 'oak_log',
      position: { x: 10, y: 64, z: 10 },
      fromPosition: { x: 9, y: 64, z: 10 },
    });
    assert.strictEqual(healed, null);
    const bot = oakBot(
      [new Vec3(10, 64, 10)],
      { '10,64,10': { name: 'oak_log', position: new Vec3(10, 64, 10) } },
      new Vec3(9, 64, 10)
    );
    const sel = getSelectableBlocks(bot, {
      matching: oakMatch, blockType: 'oak_log', maxDistance: 16, count: 12,
      kind: 'block', target: 'oak_log',
    });
    assert.strictEqual(sel.candidates.length, 1);
  } finally {
    targetFailures.clear();
  }
});

test('find_block uses shared selection with real Vec3 flow', async () => {
  targetFailures.clear();
  try {
    const { findBlock } = require('../src/primitives/perception');
    const bot = oakBot(
      [new Vec3(8, 68, 0), new Vec3(2, 64, 0)],
      {
        '8,68,0': { name: 'oak_log', position: new Vec3(8, 68, 0) },
        '2,64,0': { name: 'oak_log', position: new Vec3(2, 64, 0) },
      },
      new Vec3(0, 64, 0)
    );
    const res = await findBlock(bot, { blockType: 'oak_log', radius: 32 });
    assert.strictEqual(res.ok, true);
    // Generic ranking picks the actionable nearby block, not the canopy.
    assert.deepStrictEqual(res.position, { x: 2, y: 64, z: 0 });
  } finally {
    targetFailures.clear();
  }
});

test('mine_block_type attempts ranked Vec3 candidates and skips dig failures', async () => {
  targetFailures.clear();
  try {
    const { mineBlockType } = require('../src/primitives/mining');
    const inv = [];
    const dug = [];
    const bot = {
      entity: { position: new Vec3(0, 64, 0) },
      game: { dimension: 'minecraft:overworld' },
      inventory: { items: () => inv.slice() },
      entities: {},
      findBlocks: () => [new Vec3(2, 64, 0), new Vec3(3, 64, 0)],
      blockAt: blockAtFor({
        '2,64,0': { name: 'oak_log', position: new Vec3(2, 64, 0) },
        '3,64,0': { name: 'oak_log', position: new Vec3(3, 64, 0) },
      }),
      dig: async (block) => {
        dug.push(block.position.x);
        if (block.position.x === 2) throw new Error('dig failed oddly');
        inv.push({ name: 'oak_log', count: 1 });
      },
    };
    const res = await mineBlockType(bot, { blockType: 'oak_log', count: 1 }, {});
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(dug, [2, 3]); // failed first -> next candidate
    assert.strictEqual(res.broken, 1);
  } finally {
    targetFailures.clear();
  }
});

test('honest reasons: empty world vs all-excluded', async () => {
  targetFailures.clear();
  try {
    const { mineBlockType } = require('../src/primitives/mining');
    const emptyBot = {
      entity: { position: new Vec3(0, 64, 0) },
      game: { dimension: 'minecraft:overworld' },
      inventory: { items: () => [] },
      entities: {},
      findBlocks: () => [],
      findBlock: () => null,
      blockAt: () => null,
      dig: async () => {},
    };
    const empty = await mineBlockType(emptyBot, { blockType: 'oak_log', count: 1 }, {});
    assert.strictEqual(empty.reason, 'resource_not_seen');

    const blockedBot = {
      entity: { position: new Vec3(0, 64, 0) },
      game: { dimension: 'minecraft:overworld' },
      inventory: { items: () => [] },
      entities: {},
      findBlocks: () => [new Vec3(6, 64, 6)],
      blockAt: blockAtFor({ '6,64,6': { name: 'oak_log', position: new Vec3(6, 64, 6) } }),
      dig: async () => {},
    };
    targetFailures.recordFailure({
      dimension: 'minecraft:overworld',
      kind: 'block',
      target: 'oak_log',
      position: { x: 6, y: 64, z: 6 },
      reason: 'timeout',
      attemptedFrom: { x: 0, y: 64, z: 0 },
    });
    const blocked = await mineBlockType(blockedBot, { blockType: 'oak_log', count: 1 }, {});
    assert.strictEqual(blocked.reason, 'no_reachable_target');
    assert.strictEqual(blocked.candidatesSeen, 1);
    assert.strictEqual(blocked.candidatesSkipped, 1);
  } finally {
    targetFailures.clear();
  }
});

test('legacy Block-object findBlocks entries still normalize (compat)', () => {
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    findBlocks: () => [{ name: 'oak_log', position: new Vec3(5, 64, 5) }],
    blockAt: () => null, // must not even be needed for Block-like entries
  };
  const out = findBlockCandidates(bot, { matching: oakMatch, maxDistance: 32, count: 12 });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].name, 'oak_log');
});
