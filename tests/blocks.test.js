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
