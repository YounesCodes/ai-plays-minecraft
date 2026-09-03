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
