'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { getActionDefinitions, executeAction } = require('../src/agent/actions');

test('action definitions cover the v1 allowlist', () => {
  const names = getActionDefinitions().map((d) => d.name).sort();
  assert.deepStrictEqual(names, ['chat', 'collect_logs', 'finish', 'observe', 'wait']);
});

test('executeAction rejects unknown actions without touching the bot', async () => {
  const bot = {};
  const res = await executeAction(bot, { action: 'hack_the_planet' });
  assert.strictEqual(res.ok, false);
});

test('executeAction handles chat, wait, finish with a mock bot', async () => {
  const sent = [];
  const bot = {
    chat: (msg) => sent.push(msg),
    inventory: { items: () => [] },
    entity: { position: { x: 0, y: 64, z: 0 } },
    time: { timeOfDay: 0 },
    entities: {},
  };

  const chatRes = await executeAction(bot, { action: 'chat', message: 'hello' });
  assert.strictEqual(chatRes.ok, true);
  assert.deepStrictEqual(sent, ['hello']);

  const waitRes = await executeAction(bot, { action: 'wait', seconds: 1 });
  assert.strictEqual(waitRes.ok, true);

  const finishRes = await executeAction(bot, { action: 'finish', reason: 'done' });
  assert.strictEqual(finishRes.done, true);
});

test('executeAction times out a hung collect_logs instead of hanging', async () => {
  // Inject a stub collectLogs module (never-resolving collect) via the
  // require cache. Safe: no other test in this file populates the cache,
  // and node:test isolates files in separate processes.
  const path = require.resolve('../src/skills/collectLogs');
  const real = require.cache[path];
  require.cache[path] = {
    id: path,
    filename: path,
    loaded: true,
    exports: {
      collectLogs: () => new Promise(() => {}),
      countLogs: () => 3,
    },
  };
  process.env.PRIMITIVE_TIMEOUT_MS = '50';
  process.env.SKILL_TIMEOUT_MS = '100';
  try {
    const bot = {}; // no collectBlock/pathfinder/clearControlStates: guards must hold
    const t0 = Date.now();
    const res = await executeAction(bot, { action: 'collect_logs', amount: 1 });
    const ms = Date.now() - t0;
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.timedOut, true);
    assert.strictEqual(res.collected, 3);
    assert.ok(ms < 5000, `collect_logs returned in ${ms}ms`);
  } finally {
    delete process.env.PRIMITIVE_TIMEOUT_MS;
    delete process.env.SKILL_TIMEOUT_MS;
    if (real) require.cache[path] = real;
    else delete require.cache[path];
  }
});
