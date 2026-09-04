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
  assert.match(res.error, /No path|No reachable|No log found/);
});

test('collectLogs remembers skipped blocks across actions (no re-attempt)', async () => {
  // Fresh coordinates (hermetic vs earlier tests sharing module-level skip
  // memory). Action 1 skips unreachable A and collects B; action 2 must go
  // straight to B. Tracked goto targets prove A is attempted exactly once
  // overall — the old per-action-only memory would attempt A twice.
  const inv = [];
  const attempts = [];
  const bot = {
    inventory: { items: () => inv.slice() },
    pathfinder: {
      goto: async (goal) => {
        attempts.push(goal.x);
        if (goal.x === 50) throw new Error('no path');
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
      const a = { name: 'oak_log', position: { x: 50, y: 2, z: 50 } };
      const b = { name: 'oak_log', position: { x: 90, y: 2, z: 90 } };
      if (matching(a)) return a;
      if (matching(b)) return b;
      return null;
    },
    clearControlStates: () => {},
  };

  const first = await collectLogs(bot, 1);
  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.collected, 1);

  const second = await collectLogs(bot, 1);
  assert.strictEqual(second.ok, true);
  assert.strictEqual(second.collected, 1);
  assert.deepStrictEqual(attempts, [50, 90, 90]);
});

test('stale skips are ignored after the bot moves far away', async () => {
  // Skip recorded far from a trunk, then "teleport" next to it: the second
  // action must collect it instead of staying blind. Old permanent-skip
  // behavior fails this test (second action finds nothing).
  const inv = [];
  const position = { x: 0, y: 64, z: 0 };
  const bot = {
    entity: { position },
    inventory: { items: () => inv.slice() },
    pathfinder: {
      goto: async (goal) => {
        const dx = goal.x - position.x;
        const dz = goal.z - position.z;
        if (dx * dx + dz * dz > 20 * 20) throw new Error('too far');
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
      const a = { name: 'oak_log', position: { x: 60, y: 64, z: 60 } };
      return matching(a) ? a : null;
    },
    clearControlStates: () => {},
  };

  const first = await collectLogs(bot, 1);
  assert.strictEqual(first.ok, false); // skipped from far away

  position.x = 58;
  position.z = 58; // teleport next to the skipped trunk
  const second = await collectLogs(bot, 1);
  assert.strictEqual(second.ok, true);
  assert.strictEqual(second.collected, 1);
});



test('adjacent previously-skipped logs are retried (walking heals skips)', async () => {
  const { collectLogs, _clearSkipped } = require('../src/skills/collectLogs');
  _clearSkipped();
  const inv = [];
  const mkBot = (x, reachable) => ({
    entity: { position: { x, y: 64, z: 0 } },
    inventory: { items: () => inv.slice() },
    pathfinder: { goto: async () => { if (!reachable) throw new Error('no path'); }, stop: () => {}, setGoal: () => {} },
    collectBlock: { collect: async () => { inv.push({ name: 'oak_log', count: 1 }); }, cancelTask: () => {} },
    findBlock: ({ matching }) => {
      const b = { name: 'oak_log', position: { x: 10, y: 64, z: 0 } };
      return matching(b) ? b : null;
    },
    clearControlStates: () => {},
  });
  try {
    // Empty + waiting approach fails before collect.
    process.env.PRIMITIVE_TIMEOUT_MS = '3000';
    process.env.MAX_BLOCK_SEARCH_DISTANCE = '40';
    // 1) from far, the log is unreachable => skip recorded.
    const far = mkBot(0, false); // 10 blocks away, approach always throws
    const r1 = await collectLogs(far, 1);
    assert.strictEqual(r1.ok, false);
    // 2) now walk adjacent (bot at x=9, 1 block from the log): must collect.
    const near = mkBot(9, true); // adjacent: approach resolves, collect runs
    const r2 = await collectLogs(near, 1);
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(r2.collected, 1);
  } finally {
    delete process.env.PRIMITIVE_TIMEOUT_MS;
    delete process.env.MAX_BLOCK_SEARCH_DISTANCE;
    _clearSkipped();
  }
});
