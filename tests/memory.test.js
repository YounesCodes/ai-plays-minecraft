'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function isolateMemory() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-mem-'));
  process.env.MEMORY_DIR = dir;
  return dir;
}

test('semantic persistence + deduplication', () => {
  isolateMemory();
  const semantic = require('../src/memory/semantic');
  const a = semantic.add({ subject: 'creeper', content: 'Creepers explode when close.', confidence: 0.9 });
  assert.strictEqual(a.ok, true);
  const b = semantic.add({ subject: 'creeper', content: 'Creepers explode when close.', confidence: 0.5 });
  assert.strictEqual(b.ok, true);
  assert.strictEqual(b.deduplicated, true);
  const all = semantic.list();
  assert.strictEqual(all.filter((m) => m.subject === 'creeper').length, 1);
  assert.ok(all[0].id);
  assert.ok(all[0].createdAt);
});

test('semantic storage is bounded', () => {
  isolateMemory();
  process.env.MAX_SEMANTIC_MEMORIES = '5';
  const semantic = require('../src/memory/semantic');
  for (let i = 0; i < 10; i++) {
    semantic.add({ subject: `s${i}`, content: `fact ${i}`, confidence: 0.1 + i / 20 });
  }
  assert.ok(semantic.list().length <= 5);
  delete process.env.MAX_SEMANTIC_MEMORIES;
});

test('episodic persistence', () => {
  isolateMemory();
  const episodic = require('../src/memory/episodic');
  const res = episodic.add({ summary: 'A creeper killed me while mining.', context: { health: 9 }, lesson: 'Watch for mobs.' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(episodic.list().length, 1);
});

test('world location persistence', () => {
  isolateMemory();
  const world = require('../src/memory/world');
  const res = world.remember('diamond_vein_1', { x: -91, y: -54, z: 338 }, { observedBlocks: 4 });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(world.get('diamond_vein_1').position.x, -91);
  assert.strictEqual(world.list().length, 1);
});

test('procedural skill persistence', () => {
  isolateMemory();
  const procedural = require('../src/memory/procedural');
  procedural.upsert({ skillId: 'fight-creeper-carefully', description: 'Hit and retreat.' });
  procedural.recordOutcome('fight-creeper-carefully', true);
  procedural.recordOutcome('fight-creeper-carefully', false);
  const e = procedural.get('fight-creeper-carefully');
  assert.strictEqual(e.successCount, 1);
  assert.strictEqual(e.failureCount, 1);
});

test('missing files handled', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-mem-empty-'));
  process.env.MEMORY_DIR = dir;
  const semantic = require('../src/memory/semantic');
  assert.deepStrictEqual(semantic.list(), []);
});

test('malformed file handled safely', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-mem-bad-'));
  process.env.MEMORY_DIR = dir;
  fs.writeFileSync(path.join(dir, 'semantic.json'), '{not valid json', 'utf8');
  const semantic = require('../src/memory/semantic');
  assert.deepStrictEqual(semantic.list(), []);
});
