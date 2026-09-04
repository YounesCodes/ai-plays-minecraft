'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { validatePrimitiveCall, PRIMITIVE_NAMES } = require('../src/safety/primitiveValidator');
const { executePrimitive, listPrimitives } = require('../src/primitives');

test('primitive registry lists the trusted set', () => {
  const names = listPrimitives().map((p) => p.name);
  for (const expected of ['move_near', 'move_near_entity', 'move_away_from_entity', 'stop_movement', 'find_block', 'find_entity', 'equip_best_melee_weapon', 'attack_entity', 'stop_attacking', 'equip_item', 'inspect_inventory', 'eat_best_food', 'sleep', 'wait', 'mine_block', 'mine_block_type', 'craft_item', 'place_block', 'use_item', 'chat']) {
    assert.ok(names.includes(expected), `missing primitive ${expected}`);
  }
  assert.ok(PRIMITIVE_NAMES.length >= 20);
});

test('valid primitive calls pass', () => {
  assert.strictEqual(validatePrimitiveCall({ primitive: 'move_near', args: { x: 1, y: 64, z: 2 } }).ok, true);
  assert.strictEqual(validatePrimitiveCall({ primitive: 'wait', args: { seconds: 3 } }).ok, true);
  assert.strictEqual(validatePrimitiveCall({ primitive: 'chat', args: { message: 'hi' } }).ok, true);
  assert.strictEqual(validatePrimitiveCall({ primitive: 'attack_entity', args: { entityId: 37 } }).ok, true);
  assert.strictEqual(validatePrimitiveCall({ primitive: 'mine_block_type', args: { blockType: 'oak_log', count: 4 } }).ok, true);
  assert.strictEqual(validatePrimitiveCall({ primitive: 'eat_best_food', args: {} }).ok, true);
});

test('unknown primitive rejected', () => {
  assert.strictEqual(validatePrimitiveCall({ primitive: 'fly', args: {} }).ok, false);
  assert.strictEqual(validatePrimitiveCall({ primitive: 'bot.chat', args: {} }).ok, false);
});

test('invalid args rejected', () => {
  assert.strictEqual(validatePrimitiveCall({ primitive: 'wait', args: { seconds: 99 } }).ok, false);
  assert.strictEqual(validatePrimitiveCall({ primitive: 'move_near', args: { x: 1, y: 64 } }).ok, false);
  assert.strictEqual(validatePrimitiveCall({ primitive: 'attack_entity', args: {} }).ok, false);
  assert.strictEqual(validatePrimitiveCall({ primitive: 'craft_item', args: { item: 'Bad Name!' } }).ok, false);
  assert.strictEqual(validatePrimitiveCall({ primitive: 'chat', args: { message: '' } }).ok, false);
});

test('unexpected fields rejected', () => {
  assert.strictEqual(validatePrimitiveCall({ primitive: 'wait', args: { seconds: 1, extra: 2 } }).ok, false);
  assert.strictEqual(validatePrimitiveCall({ primitive: 'wait', args: { seconds: 1 }, foo: 'bar' }).ok, false);
});

test('dangerous fields rejected', () => {
  assert.strictEqual(validatePrimitiveCall({ primitive: 'wait', args: { seconds: 1, exec: 'rm' } }).ok, false);
  assert.strictEqual(validatePrimitiveCall({ primitive: 'wait', args: { seconds: 1, code: 'x' } }).ok, false);
  assert.strictEqual(validatePrimitiveCall({ primitive: 'chat', args: { message: 'hi', shell: true } }).ok, false);
  assert.strictEqual(validatePrimitiveCall({ primitive: 'wait', args: JSON.parse('{"seconds":1,"__proto__":1}') }).ok, false);
  assert.strictEqual(validatePrimitiveCall({ primitive: 'eval', args: {} }).ok, false);
});

test('executePrimitive validates before touching the bot', async () => {
  let touched = false;
  const bot = { chat: () => { touched = true; } };
  const res = await executePrimitive(bot, { primitive: 'nope', args: {} });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(touched, false);
});

test('executePrimitive chat works with a mock bot', async () => {
  const sent = [];
  const bot = { chat: (m) => sent.push(m) };
  const res = await executePrimitive(bot, { primitive: 'chat', args: { message: 'hello' } });
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(sent, ['hello']);
});

test('executePrimitive inspect_inventory returns structured data', async () => {
  const bot = { inventory: { items: () => [{ name: 'oak_log', count: 3 }], slots: [] }, heldItem: null };
  const res = await executePrimitive(bot, { primitive: 'inspect_inventory', args: {} });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.items.oak_log, 3);
});

test('executePrimitive find_entity works with mock entities', async () => {
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    entities: {
      7: { id: 7, name: 'creeper', position: { x: 3, y: 64, z: 0, distanceTo: () => 3 } },
    },
  };
  const res = await executePrimitive(bot, { primitive: 'find_entity', args: { hostileOnly: true } });
  assert.strictEqual(res.ok, true);
  assert.ok(res.entities.some((e) => e.type === 'creeper'));
});

test('move_near aborts on interrupt instead of running out the timeout', async () => {
  let stopped = 0;
  const bot = {
    pathfinder: {
      goto: () => new Promise(() => {}), // hangs: without abort this takes the full timeout
      stop: () => {
        stopped += 1;
      },
    },
    clearControlStates: () => {
      stopped += 1;
    },
  };
  const t0 = Date.now();
  const res = await executePrimitive(
    bot,
    { primitive: 'move_near', args: { x: 100, y: 64, z: 100 } },
    { timeoutMs: 5000, shouldAbort: () => ({ type: 'immediate_threat', reason: 'creeper' }) }
  );
  const ms = Date.now() - t0;
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.aborted, true);
  assert.match(res.error, /creeper/);
  assert.ok(stopped > 0, 'abort stops the bot');
  assert.ok(ms < 4000, `aborted in ${ms}ms, well before the timeout`);
});

test('move_near timeout stops the bot (no zombie goto)', async () => {
  let stopped = 0;
  const bot = {
    pathfinder: {
      goto: () => new Promise(() => {}),
      stop: () => {
        stopped += 1;
      },
    },
    clearControlStates: () => {
      stopped += 1;
    },
  };
  const res = await executePrimitive(
    bot,
    { primitive: 'move_near', args: { x: 1, y: 64, z: 2 } },
    { timeoutMs: 1000 }
  );
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.timedOut, true);
  assert.ok(stopped > 0, 'timeout stops the bot');
});

test('attack_entity aborts mid-loop on interrupt', async () => {
  let swings = 0;
  let stopped = 0;
  let polls = 0;
  const bot = {
    health: 20,
    entities: { 37: { id: 37, position: { x: 1, y: 64, z: 1 } } },
    attack: async () => {
      swings += 1;
    },
    pathfinder: {
      stop: () => {
        stopped += 1;
      },
    },
    clearControlStates: () => {
      stopped += 1;
    },
  };
  const res = await executePrimitive(
    bot,
    { primitive: 'attack_entity', args: { entityId: 37 } },
    {
      timeoutMs: 10000,
      maxAttackSeconds: 20,
      shouldAbort: () => {
        polls += 1;
        return polls >= 2 ? { type: 'immediate_threat', reason: 'creeper' } : null;
      },
    }
  );
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.aborted, true);
  assert.ok(swings >= 1, 'swung before the abort arrived');
  assert.ok(stopped > 0, 'abort stops the bot');
});

test('stop_attacking actually stops movement', async () => {
  let stopped = 0;
  const bot = {
    pathfinder: {
      stop: () => {
        stopped += 1;
      },
    },
    clearControlStates: () => {
      stopped += 1;
    },
  };
  const res = await executePrimitive(bot, { primitive: 'stop_attacking', args: {} });
  assert.strictEqual(res.ok, true);
  assert.ok(stopped > 0, 'stop_attacking halts the bot');
});

test('executePrimitive find_block works with mock blocks', async () => {
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    findBlock: ({ matching }) => {
      if (typeof matching !== 'function') throw new Error('string matching unsupported');
      const b = { name: 'oak_log', position: { x: 5, y: 64, z: 0 } };
      return matching(b) ? b : null;
    },
  };
  const res = await executePrimitive(bot, { primitive: 'find_block', args: { blockType: 'oak_log' } });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.blockType, 'oak_log');
  assert.deepStrictEqual(res.position, { x: 5, y: 64, z: 0 });
});
