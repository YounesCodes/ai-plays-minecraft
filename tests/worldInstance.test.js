'use strict';

// World-instance identity + namespace isolation + dimension filtering.
// No Minecraft, no network (tmp dirs + MEMORY_DIR isolation).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validId, generateId, readWorldId, ensureWorldId, namespaceFile } = require('../src/world/instance');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'worldid-test-'));
}

function freshEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'worldmem-test-'));
  process.env.MEMORY_DIR = tmp;
  delete process.env.AI_WORLD_ID;
  return tmp;
}

function clearEnv() {
  delete process.env.MEMORY_DIR;
  delete process.env.AI_WORLD_ID;
}

test('generated IDs are valid and unique', () => {
  const a = generateId();
  const b = generateId();
  assert.ok(validId(a));
  assert.ok(validId(b));
  assert.notStrictEqual(a, b);
});

test('fresh worlds with same seed get different IDs', () => {
  const d1 = tmpDir();
  const d2 = tmpDir();
  const a = ensureWorldId(d1, { seed: '20260904' });
  const b = ensureWorldId(d2, { seed: '20260904' });
  assert.notStrictEqual(a.id, b.id);
  assert.strictEqual(a.seed, '20260904');
  // Ensure never regenerates.
  assert.strictEqual(ensureWorldId(d1, { seed: '20260904' }).id, a.id);
});

test('restored snapshot retains its original ID', () => {
  const snap = tmpDir();
  const first = ensureWorldId(snap, { seed: '20260904' });
  // Simulate snapshot/restore as a directory copy.
  const active = tmpDir();
  fs.cpSync(path.join(snap, '.ai-world-id'), path.join(active, '.ai-world-id'));
  assert.strictEqual(readWorldId(active).id, first.id);
});

test('world memory A is invisible in B; restoring A restores locations', () => {
  const tmp = freshEnv();
  try {
    delete require.cache[require.resolve('../src/memory/world')];
    const world = require('../src/memory/world');
    const dA = tmpDir();
    const dB = tmpDir();
    const idA = ensureWorldId(dA, { seed: '20260904' }).id;
    const idB = ensureWorldId(dB, { seed: '20260904' }).id;
    process.env.AI_WORLD_ID = idA;
    world.remember('crafting_station', { x: 1, y: 64, z: 2 }, { kind: 'workstation' }, 'overworld');
    assert.ok(world.get('crafting_station'));
    process.env.AI_WORLD_ID = idB;
    assert.strictEqual(world.get('crafting_station'), null);
    world.remember('other', { x: 9, y: 9, z: 9 }, {}, 'overworld');
    process.env.AI_WORLD_ID = idA;
    assert.ok(world.get('crafting_station'));
    assert.strictEqual(world.get('other'), null);
    // Files are namespaced, legacy untouched.
    assert.ok(fs.existsSync(path.join(tmp, `world.${idA}.json`)));
    assert.ok(fs.existsSync(path.join(tmp, `world.${idB}.json`)));
    assert.ok(!fs.existsSync(path.join(tmp, 'world.json')));
  } finally {
    clearEnv();
  }
});

test('malicious namespace cannot escape MEMORY_DIR', () => {
  assert.strictEqual(namespaceFile('../../evil'), null);
  assert.strictEqual(namespaceFile('world.json'), null);
  assert.strictEqual(namespaceFile(''), null);
  assert.strictEqual(namespaceFile(null), null);
  const good = namespaceFile('world_0123456789abcdef');
  assert.strictEqual(good, 'world.world_0123456789abcdef');
  assert.ok(!good.includes('/') && !good.includes('..'));
});

test('legacy file is never auto-imported into a namespace', () => {
  const tmp = freshEnv();
  try {
    fs.writeFileSync(path.join(tmp, 'world.json'), JSON.stringify([{ name: 'old', position: { x: 1, y: 2, z: 3 } }]));
    delete require.cache[require.resolve('../src/memory/world')];
    const world = require('../src/memory/world');
    process.env.AI_WORLD_ID = generateId();
    assert.strictEqual(world.get('old'), null);
    assert.deepStrictEqual(world.list(), []);
    delete process.env.AI_WORLD_ID;
    assert.ok(world.get('old'));
  } finally {
    clearEnv();
  }
});

test('workstation selection respects dimension', () => {
  const { nearestWorkstation } = require('../src/curriculum/manager');
  const locs = [
    { name: 'crafting_station', position: { x: 3, y: 64, z: 0 }, metadata: { kind: 'workstation' }, dimension: 'the_nether' },
    { name: 'crafting_station', position: { x: 3, y: 64, z: 0 }, metadata: { kind: 'workstation' }, dimension: 'minecraft:overworld' },
  ];
  // Only the Overworld entry is viable here despite identical coordinates.
  const over = nearestWorkstation(locs, { x: 0, y: 64, z: 0 }, 'overworld');
  assert.ok(over);
  assert.strictEqual(over.distance, 3);
  const nether = nearestWorkstation(
    [{ name: 'crafting_station', position: { x: 3, y: 64, z: 0 }, metadata: { kind: 'workstation' }, dimension: 'the_nether' }],
    { x: 0, y: 64, z: 0 },
    'overworld'
  );
  assert.strictEqual(nether, null);
});

test('known-location context preserves dimension metadata', () => {
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
    list: () => [{ name: 'crafting_station', position: { x: 3, y: 64, z: 4 }, dimension: 'minecraft:overworld', metadata: { kind: 'workstation', block: 'crafting_table' } }],
  };
  const obs = observe(bot, { worldMemory });
  const found = (obs.knownLocationsNearby || []).find((e) => e.name === 'crafting_station');
  assert.ok(found);
  assert.strictEqual(found.dimension, 'minecraft:overworld');
});
