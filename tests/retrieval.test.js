'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { retrieveRelevant } = require('../src/memory/retrieval');

function stores() {
  return {
    semantic: [
      { subject: 'creeper', content: 'Creepers explode when they remain close.' },
      { subject: 'diamond_ore', content: 'Stone pickaxes do not produce diamond drops.' },
      { subject: 'bread', content: 'Bread restores hunger.' },
    ],
    episodic: [
      { summary: 'A creeper killed me while mining at night.', lesson: 'Monitor mobs.' },
      { summary: 'Found diamonds deep underground.', lesson: 'Bring iron pickaxe.' },
    ],
    procedural: [
      { skillId: 'fight-creeper-carefully', description: 'Hit a creeper and retreat before it detonates.' },
    ],
    world: [
      { name: 'diamond_vein_1', metadata: { observedBlocks: 4 } },
      { name: 'temporary_shelter', metadata: { beds: 1 } },
    ],
  };
}

function perceptionWith({ entities = [], blocks = [], timeCategory = 'day', food = 20 } = {}) {
  return {
    nearbyEntitiesDetailed: entities,
    interestingBlocks: blocks,
    environment: { timeCategory },
    self: { food, health: 20 },
    food,
    equipment: {},
    knownLocationsNearby: [],
    inventory: {},
  };
}

test('creeper context retrieves creeper memories', () => {
  const r = retrieveRelevant({
    goal: { description: 'Survive' },
    perception: perceptionWith({ entities: [{ type: 'creeper', distance: 4, hostile: true }] }),
    stores: stores(),
  });
  const subjects = r.semantic.map((m) => m.subject);
  assert.ok(subjects.includes('creeper'));
  assert.ok(!subjects.includes('diamond_ore'));
});

test('diamond context retrieves mining/tool memories', () => {
  const r = retrieveRelevant({
    goal: { description: 'Mine diamonds' },
    perception: perceptionWith({ blocks: [{ type: 'diamond_ore', distance: 5 }] }),
    stores: stores(),
  });
  const subjects = r.semantic.map((m) => m.subject);
  assert.ok(subjects.includes('diamond_ore'));
});

test('unrelated memories are excluded', () => {
  const r = retrieveRelevant({
    goal: { description: 'Build a wheat farm in the plains' },
    perception: perceptionWith({}),
    stores: stores(),
  });
  // Farm goal shares no tokens with creeper/diamond memories.
  assert.ok(!r.semantic.some((m) => m.subject === 'creeper'));
  assert.ok(!r.semantic.some((m) => m.subject === 'diamond_ore'));
});

test('night context retrieves shelter memories', () => {
  const r = retrieveRelevant({
    goal: { description: 'Survive the night' },
    perception: perceptionWith({ timeCategory: 'night' }),
    stores: {
      semantic: [{ subject: 'night', content: 'Hostile mobs spawn at night; shelter helps.' }],
      episodic: [], procedural: [],
      world: [{ name: 'temporary_shelter', metadata: {} }],
    },
  });
  assert.ok(r.semantic.length >= 1);
});
