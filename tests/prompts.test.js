'use strict';

// Guards the bug class where the validator rejects what the prompt never
// taught. The primitive catalog is RENDERED from PRIMITIVE_SCHEMAS, so this
// also acts as a drift test: every enforced name/bound/enum must be stated.

const test = require('node:test');
const assert = require('node:assert');
const { buildSystemPromptAutonomous } = require('../src/agent/prompts');
const { PRIMITIVE_SCHEMAS, PRIMITIVE_NAMES } = require('../src/safety/primitiveValidator');
const { renderCatalog, renderPrimitive } = require('../src/safety/primitiveCatalog');

test('autonomous prompt states the slim contract', () => {
  const prompt = buildSystemPromptAutonomous('test directive');
  for (const needle of [
    'goalChange',
    'nextStep',
    'requiresRelocation',
    'resource_not_seen',
    'no_reachable_target',
    'entityId',
    'overrides older memories',
    'toolWasSuitable',
  ]) {
    assert.ok(prompt.includes(needle), `prompt missing: ${needle}`);
  }
  assert.ok(prompt.includes('No plan, no proposeSkill, no memoryToCreate'), 'obsolete fields must be explicitly forbidden');
});

test('catalog renders every primitive with every arg', () => {
  const lines = renderCatalog({});
  assert.strictEqual(lines.length, PRIMITIVE_NAMES.length);
  for (const name of PRIMITIVE_NAMES) {
    const line = lines.find((l) => l.startsWith(`- ${name}(`));
    assert.ok(line, `catalog missing primitive: ${name}`);
    for (const arg of Object.keys(PRIMITIVE_SCHEMAS[name])) {
      assert.ok(line.includes(arg), `${name} line missing arg ${arg}`);
    }
  }
});

test('catalog states attack_entity.entityId as required integer', () => {
  const line = renderPrimitive('attack_entity');
  assert.match(line, /entityId.*integer.*required/);
});

test('catalog states equip_item destination enum', () => {
  const line = renderPrimitive('equip_item');
  for (const dest of ['hand', 'off-hand', 'head', 'torso', 'legs', 'feet']) {
    assert.ok(line.includes(dest), `missing destination ${dest}`);
  }
});

test('catalog states explore direction enum and distance bounds', () => {
  const line = renderPrimitive('explore');
  for (const dir of ['north', 'south', 'east', 'west', 'random']) {
    assert.ok(line.includes(dir), `missing direction ${dir}`);
  }
  assert.match(line, /distance.*8\.\.64/);
});

test('catalog states wait seconds and mine count bounds', () => {
  assert.match(renderPrimitive('wait'), /seconds.*1\.\.10/);
  assert.match(renderPrimitive('mine_block_type'), /count.*1\.\.16/);
});

test('prompt catalog matches validator source (drift)', () => {
  const prompt = buildSystemPromptAutonomous('test directive');
  // Every schema bound rendered anywhere must appear in the shipped prompt.
  for (const name of ['attack_entity', 'equip_item', 'explore', 'wait', 'mine_block_type']) {
    const rendered = renderPrimitive(name);
    // The exact rendered line (minus description) must be in the prompt.
    assert.ok(prompt.includes(rendered), `prompt drifted from schema for ${name}:\n${rendered}`);
  }
});

test('entity context grounds entityId for the model', () => {
  const { buildContext } = require('../src/agent/context');
  const ctx = buildContext({
    directive: 'test',
    goalState: { currentGoal: { description: 'g' }, subgoals: [], suspendedGoal: null },
    perception: {
      self: { health: 20 }, equipment: {}, inventory: {},
      environment: {}, nearbyEntitiesDetailed: [{ id: 52, type: 'zombie', hostile: true, distance: 4.8 }],
      interestingBlocks: [], knownLocationsNearby: [],
    },
    relevantMemories: { semantic: [], episodic: [], procedural: [], world: [] },
    availableSkills: [],
  });
  const e = ctx.state.nearbyEntities[0];
  assert.strictEqual(e.entityId, 52);
  assert.strictEqual(e.id, 52);
});
