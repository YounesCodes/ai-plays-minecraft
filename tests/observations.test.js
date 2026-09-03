'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { observe } = require('../src/bot/observations');

function mockBot() {
  return {
    health: 20,
    food: 18,
    entity: { position: { x: 100.44, y: 64, z: -42.84, distanceTo: () => 7.44 } },
    time: { timeOfDay: 3821 },
    inventory: {
      items: () => [
        { name: 'oak_log', count: 4 },
        { name: 'oak_log', count: 2 },
        { name: 'dirt', count: 1 },
      ],
    },
    entities: {
      1: { name: 'cow', position: { x: 105, y: 64, z: -40, distanceTo: () => 7.44 } },
    },
  };
}

test('observation is bounded and JSON-serializable', () => {
  const obs = observe(mockBot(), { radius: 16, maxEntities: 12 });
  assert.strictEqual(obs.health, 20);
  assert.strictEqual(obs.inventory.oak_log, 6);
  assert.strictEqual(obs.position.x, 100.4);
  assert.strictEqual(obs.nearbyEntities.length, 1);
  assert.strictEqual(obs.nearbyEntities[0].name, 'cow');
  // Must survive a JSON round-trip (no raw Mineflayer objects).
  assert.deepStrictEqual(JSON.parse(JSON.stringify(obs)), obs);
});

test('observation bounds entity count', () => {
  const bot = mockBot();
  bot.entities = {};
  for (let i = 0; i < 50; i++) {
    bot.entities[i] = { name: 'pig', position: { x: 0, y: 64, z: 0, distanceTo: () => 5 } };
  }
  const obs = observe(bot, { radius: 16, maxEntities: 12 });
  assert.ok(obs.nearbyEntities.length <= 12);
});
