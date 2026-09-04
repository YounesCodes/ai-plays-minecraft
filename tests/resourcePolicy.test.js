'use strict';

// PHASE 1-3: local acquisition budget, distance-aware timeouts, widening.
// mine_block_type must not chase explore-range targets; beyond-budget
// candidates are deferred with relocation signal, never attempted.

const test = require('node:test');
const assert = require('node:assert');
const { Vec3 } = require('vec3');
const {
  mineBlockType,
  maxResourceApproach,
  approachTimeoutFor,
} = require('../src/primitives/mining');
const targetFailures = require('../src/navigation/targetFailures');

function logBot(positions, blockName = 'oak_log', botPos = new Vec3(0, 64, 0), extra = {}) {
  return {
    entity: { position: botPos },
    game: { dimension: 'minecraft:overworld' },
    inventory: { items: () => [] },
    entities: {},
    findBlocks: ({ count } = {}) => positions.slice(0, count || positions.length),
    blockAt: (p) => ({
      name: blockName,
      position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)),
    }),
    dig: async () => {},
    ...extra,
  };
}

test('approach budget defaults to local range with env override', () => {
  delete process.env.MAX_RESOURCE_APPROACH_DISTANCE;
  const d = maxResourceApproach();
  assert.ok(d >= 16 && d <= 24, `default ${d} in 16..24`);
  process.env.MAX_RESOURCE_APPROACH_DISTANCE = '8';
  assert.strictEqual(maxResourceApproach(), 8);
  process.env.MAX_RESOURCE_APPROACH_DISTANCE = '999';
  assert.strictEqual(maxResourceApproach(), 64);
  delete process.env.MAX_RESOURCE_APPROACH_DISTANCE;
});

test('approach timeout grows with distance within strict bounds', () => {
  const near = approachTimeoutFor(5);
  const far = approachTimeoutFor(20);
  assert.ok(far > near, `far ${far} > near ${near}`);
  assert.ok(near >= 3000 && far <= 45000, `bounded: ${near}, ${far}`);
  assert.strictEqual(approachTimeoutFor(5) <= 20000, true);
});

test('beyond-budget candidates are deferred with relocation signal', async () => {
  targetFailures.clear();
  try {
    delete process.env.MAX_RESOURCE_APPROACH_DISTANCE; // default ~20
    const bot = logBot([new Vec3(50, 64, 0), new Vec3(55, 64, 5)], 'oak_log', new Vec3(0, 64, 0), {
      dig: async () => { throw new Error('must never dig deferred'); },
    });
    const res = await mineBlockType(bot, { blockType: 'oak_log', count: 1 }, {});
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'no_reachable_target');
    assert.notStrictEqual(res.reason, 'resource_not_seen');
    assert.strictEqual(res.requiresRelocation, true);
    assert.ok(res.candidatesSeen >= 2, `seen ${res.candidatesSeen}`);
    assert.ok(res.candidatesDeferred >= 2, `deferred ${res.candidatesDeferred}`);
    assert.ok(res.nearestDeferredDistance > 20, `nearest ${res.nearestDeferredDistance}`);
    assert.strictEqual(res.candidatesFailed, 0); // never attempted
  } finally {
    targetFailures.clear();
    delete process.env.MAX_RESOURCE_APPROACH_DISTANCE;
  }
});

test('local candidate attempted while distant deferred untouched', async () => {
  targetFailures.clear();
  try {
    const dug = [];
    const inv = [];
    const bot = {
      entity: { position: new Vec3(0, 64, 0) },
      game: { dimension: 'minecraft:overworld' },
      inventory: { items: () => inv.slice() },
      entities: {},
      findBlocks: () => [new Vec3(4, 64, 0), new Vec3(50, 64, 0)],
      blockAt: (p) => ({ name: 'oak_log', position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) }),
      dig: async (b) => {
        dug.push(b.position.x);
        inv.push({ name: 'oak_log', count: 1 });
      },
    };
    const res = await mineBlockType(bot, { blockType: 'oak_log', count: 1 }, {});
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(dug, [4]);
    assert.ok(res.candidatesDeferred >= 1);
  } finally {
    targetFailures.clear();
  }
});

test('progressive widening escapes an excluded canopy cluster', async () => {
  targetFailures.clear();
  try {
    // First 16 positions: high canopy column (all pre-excluded).
    // Position 17+: reachable ground trunk at another column.
    const canopy = [];
    for (let y = 70; y < 86; y++) canopy.push(new Vec3(10, y, 10));
    const ground = new Vec3(12, 64, 12);
    const all = [...canopy, ground];
    const dug = [];
    const inv = [];
    const bot = {
      entity: { position: new Vec3(10, 64, 8) },
      game: { dimension: 'minecraft:overworld' },
      inventory: { items: () => inv.slice() },
      entities: {},
      findBlocks: ({ count } = {}) => all.slice(0, count || all.length),
      blockAt: (p) => ({ name: 'oak_log', position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) }),
      dig: async (b) => {
        dug.push(`${b.position.x},${b.position.y},${b.position.z}`);
        inv.push({ name: 'oak_log', count: 1 });
      },
    };
    for (const p of canopy) {
      targetFailures.recordFailure({
        dimension: 'minecraft:overworld', kind: 'block', target: 'oak_log',
        position: { x: p.x, y: p.y, z: p.z }, reason: 'timeout',
        attemptedFrom: { x: 10, y: 64, z: 8 },
      });
    }
    const res = await mineBlockType(bot, { blockType: 'oak_log', count: 1 }, {});
    assert.strictEqual(res.ok, true);
    assert.ok(dug.some((k) => k === '12,64,12'), `dug ${JSON.stringify(dug)}`);
    assert.ok(res.widenedTo >= 32, `widened to ${res.widenedTo}`);
  } finally {
    targetFailures.clear();
  }
});
