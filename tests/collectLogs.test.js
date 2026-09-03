'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { collectLogs, countLogs } = require('../src/skills/collectLogs');

test('countLogs totals _log items only', () => {
  const bot = {
    inventory: {
      items: () => [
        { name: 'oak_log', count: 2 },
        { name: 'dirt', count: 5 },
        { name: 'birch_log', count: 3 },
      ],
    },
  };
  assert.strictEqual(countLogs(bot), 5);
});

test('collectLogs skips unreachable blocks and collects reachable ones', async () => {
  const inv = [];
  let gotos = 0;
  const bot = {
    inventory: { items: () => inv.slice() },
    pathfinder: {
      goto: async () => {
        gotos += 1;
        if (gotos === 1) throw new Error('no path');
      },
      stop: () => {},
    },
    collectBlock: {
      collect: async () => {
        inv.push({ name: 'oak_log', count: 1 });
      },
      cancelTask: (cb) => {
        if (cb) cb();
      },
    },
    findBlock: ({ matching }) => {
      const a = { name: 'oak_log', position: { x: 1, y: 2, z: 3 } };
      const b = { name: 'oak_log', position: { x: 9, y: 2, z: 9 } };
      if (matching(a)) return a;
      if (matching(b)) return b;
      return null;
    },
    clearControlStates: () => {},
  };

  const res = await collectLogs(bot, 1);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.collected, 1);
  assert.strictEqual(gotos, 2); // first block skipped after failed approach
});

test('collectLogs reports cleanly when no reachable log exists', async () => {
  const bot = {
    inventory: { items: () => [] },
    pathfinder: {
      goto: async () => {
        throw new Error('no path');
      },
      stop: () => {},
    },
    collectBlock: {
      collect: async () => {},
      cancelTask: (cb) => {
        if (cb) cb();
      },
    },
    findBlock: ({ matching }) => {
      const a = { name: 'oak_log', position: { x: 1, y: 2, z: 3 } };
      return matching(a) ? a : null;
    },
    clearControlStates: () => {},
  };

  const res = await collectLogs(bot, 2);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.collected, 0);
  assert.match(res.error, /No path|No log found/);
});
