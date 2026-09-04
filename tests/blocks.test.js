'use strict';

// Guards the live bug where name strings were passed straight to
// Mineflayer findBlock matching (which only accepts predicates or numeric
// type ids), so lookups silently matched nothing.

const test = require('node:test');
const assert = require('node:assert');
const { matchBlockName } = require('../src/blocks');

test('matchBlockName matches by block name string', () => {
  const match = matchBlockName('oak_log');
  assert.strictEqual(typeof match, 'function');
  assert.strictEqual(match({ name: 'oak_log' }), true);
  assert.strictEqual(match({ name: 'birch_log' }), false);
  assert.strictEqual(match(null), false);
  assert.strictEqual(match({}), false);
});

test('matchBlockName accepts arrays and ignores non-strings', () => {
  const match = matchBlockName(['oak_log', 17, null, 'birch_log']);
  assert.strictEqual(match({ name: 'oak_log' }), true);
  assert.strictEqual(match({ name: 'birch_log' }), true);
  assert.strictEqual(match({ name: 'stone' }), false);
});

test('blockAtPos passes a floored Vec3 (plain objects throw in real Mineflayer)', () => {
  const { Vec3 } = require('vec3');
  const seen = [];
  const bot = {
    blockAt: (p) => {
      if (typeof p.floored !== 'function') throw new Error('pos.floored is not a function');
      seen.push([p.x, p.y, p.z]);
      return { name: 'stone', position: p };
    },
  };
  const { blockAtPos } = require('../src/blocks');
  const block = blockAtPos(bot, 1.7, 2.2, 3.9);
  assert.strictEqual(block.name, 'stone');
  assert.deepStrictEqual(seen, [[1, 2, 3]]);
  assert.strictEqual(blockAtPos(bot, 1, 2, 3) instanceof Object, true);
  assert.strictEqual(blockAtPos({}, 1, 2, 3), null);
  assert.strictEqual(blockAtPos({ blockAt: () => { throw new Error('nope'); } }, 1, 2, 3), null);
  void Vec3;
});

test('findItemOrBlock works across minecraft-data versions', () => {
  const { findItemOrBlock } = require('../src/blocks');
  const modern = { itemsByName: { stick: { id: 1, name: 'stick' } }, blocksByName: { stone: { id: 2, name: 'stone' } } };
  assert.deepStrictEqual(findItemOrBlock(modern, 'stick'), { id: 1, name: 'stick' });
  assert.deepStrictEqual(findItemOrBlock(modern, 'stone'), { id: 2, name: 'stone' });
  assert.strictEqual(findItemOrBlock(modern, 'nope'), null);
  const legacy = { findItemOrBlockByName: (n) => (n === 'old' ? { id: 9 } : null) };
  assert.deepStrictEqual(findItemOrBlock(legacy, 'old'), { id: 9 });
  assert.strictEqual(findItemOrBlock(null, 'x'), null);
});
