'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { observe, timeCategory } = require('../src/bot/observations');

function richBot() {
  return {
    health: 16,
    food: 11,
    inventory: {
      items: () => [
        { name: 'oak_log', count: 13 },
        { name: 'cobblestone', count: 42 },
        { name: 'bread', count: 2 },
      ],
      slots: [],
    },
    heldItem: { name: 'stone_sword', durabilityUsed: 10, maxDurability: 131 },
    entity: { position: { x: -84.2, y: 63, z: 201.4 } },
    game: { dimension: 'overworld' },
    time: { timeOfDay: 14000 },
    isRaining: false,
    blockAt: () => ({ light: 6 }),
    findBlocks: () => [],
    entities: {
      37: { id: 37, name: 'creeper', position: { x: -80, y: 63, z: 201, distanceTo: () => 8.2 } },
    },
  };
}

test('rich perception includes autonomous fields', () => {
  const obs = observe(richBot(), { radius: 24, maxEntities: 20 });
  assert.strictEqual(obs.self.health, 16);
  assert.strictEqual(obs.self.food, 11);
  assert.strictEqual(obs.equipment.mainHand, 'stone_sword');
  assert.strictEqual(obs.environment.timeCategory, 'night');
  assert.strictEqual(obs.inventory.oak_log, 13);
  assert.ok(obs.nearbyEntitiesDetailed.some((e) => e.type === 'creeper' && e.hostile === true));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(obs)), obs);
});

test('legacy flat fields preserved', () => {
  const obs = observe(richBot());
  assert.strictEqual(obs.health, 16);
  assert.strictEqual(obs.timeOfDay, 14000);
  assert.strictEqual(obs.inventory.bread, 2);
  assert.ok(Array.isArray(obs.nearbyEntities));
});

test('time categories', () => {
  assert.strictEqual(timeCategory(14000), 'night');
  assert.strictEqual(timeCategory(6000), 'day');
});

test('perception never throws on empty bot', () => {
  const obs = observe({}, {});
  assert.ok(obs && typeof obs === 'object');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(obs)), obs);
});
