'use strict';

// Deterministic curriculum tactics: mechanically obvious actions only.
// No LLM, mostly no Minecraft (recipe data is real installed data).

const test = require('node:test');
const assert = require('node:assert');
const { getCurriculumTactic } = require('../src/curriculum/tactics');

function status(over = {}) {
  return {
    target: 'oak_planks',
    craftAs: 'oak_planks',
    needs: { oak_log: 1 },
    missing: {},
    materialsReady: true,
    requiresTable: false,
    tableNearby: null,
    knownStation: null,
    craftableMissing: [],
    ...over,
  };
}

test('A: ready craft without table requirement -> craft tactic', () => {
  const res = getCurriculumTactic({
    status: status(), milestoneId: 'make_planks', inventory: { oak_log: 2 }, emergency: false,
  });
  assert.ok(res);
  assert.strictEqual(res.reason, 'craft-ready');
  assert.deepStrictEqual(res.step, { type: 'primitive', name: 'craft_item', args: { item: 'oak_planks', count: 1 } });
});

test('C: ready craft + nearby table -> craft tactic', () => {
  const res = getCurriculumTactic({
    status: status({ target: 'wooden_pickaxe', craftAs: 'wooden_pickaxe', requiresTable: true, tableNearby: true }),
    milestoneId: 'craft_wooden_pickaxe',
    inventory: { oak_planks: 3, stick: 2 },
    emergency: false,
  });
  assert.ok(res);
  assert.strictEqual(res.reason, 'craft-at-table');
  assert.strictEqual(res.step.args.item, 'wooden_pickaxe');
});

test('D: ready craft + far remembered station -> return tactic', () => {
  const res = getCurriculumTactic({
    status: status({ target: 'wooden_pickaxe', craftAs: 'wooden_pickaxe', requiresTable: true, tableNearby: false, knownStation: { name: 'crafting_station', distance: 40 } }),
    milestoneId: 'craft_wooden_pickaxe',
    inventory: { oak_planks: 3, stick: 2 },
    emergency: false,
  });
  assert.ok(res);
  assert.strictEqual(res.reason, 'return-to-station');
  assert.deepStrictEqual(res.step, { type: 'primitive', name: 'move_to_known_location', args: { name: 'crafting_station', range: 4 } });
});

test('no known station and no nearby table -> null (cognition decides)', () => {
  const res = getCurriculumTactic({
    status: status({ target: 'wooden_pickaxe', craftAs: 'wooden_pickaxe', requiresTable: true, tableNearby: false, knownStation: null }),
    milestoneId: 'craft_wooden_pickaxe',
    inventory: { oak_planks: 3, stick: 2 },
    emergency: false,
  });
  assert.strictEqual(res, null);
});

test('B: establish milestone + table held -> place tactic', () => {
  const res = getCurriculumTactic({
    status: null, milestoneId: 'establish_crafting_table',
    inventory: { crafting_table: 1 }, emergency: false, tableNearby: false,
  });
  assert.ok(res);
  assert.strictEqual(res.reason, 'place-table');
  assert.deepStrictEqual(res.step, { type: 'primitive', name: 'place_block_nearby', args: { item: 'crafting_table' } });
});

test('establish with table already nearby -> null', () => {
  const res = getCurriculumTactic({
    status: null, milestoneId: 'establish_crafting_table',
    inventory: { crafting_table: 1 }, emergency: false, tableNearby: true,
  });
  assert.strictEqual(res, null);
});

test('E: one craftable missing ingredient -> intermediate craft', () => {
  const res = getCurriculumTactic({
    status: status({
      target: 'wooden_pickaxe', craftAs: 'wooden_pickaxe', requiresTable: false,
      missing: { stick: 2 }, materialsReady: false,
      craftableMissing: [{ item: 'stick', canCraftNow: true, missingCount: 2, recipeYield: 4, requiresTable: false }],
    }),
    milestoneId: 'craft_wooden_pickaxe',
    inventory: { oak_planks: 5 },
    emergency: false,
  });
  assert.ok(res);
  assert.strictEqual(res.reason, 'craft-intermediate');
  assert.strictEqual(res.step.args.item, 'stick');
});

test('ambiguous intermediates -> null', () => {
  const res = getCurriculumTactic({
    status: status({
      materialsReady: false,
      craftableMissing: [{ item: 'a', canCraftNow: true }, { item: 'b', canCraftNow: true }],
    }),
    milestoneId: 'craft_wooden_pickaxe',
    inventory: {},
    emergency: false,
  });
  assert.strictEqual(res, null);
});

test('intermediate needing a table without one nearby -> null', () => {
  const res = getCurriculumTactic({
    status: status({
      target: 'stone_pickaxe', craftAs: 'stone_pickaxe', requiresTable: true, tableNearby: false,
      missing: { cobblestone: 3 }, materialsReady: false,
      craftableMissing: [{ item: 'cobblestone', canCraftNow: true }],
    }),
    milestoneId: 'craft_stone_pickaxe',
    inventory: { stone: 3 },
    emergency: false,
  });
  // Cobblestone is not craftable anyway (no recipe) — and table-gated
  // intermediates are left to cognition.
  assert.strictEqual(res, null);
});

test('emergency prevents all tactics', () => {
  const res = getCurriculumTactic({
    status: status(), milestoneId: 'make_planks', inventory: { oak_log: 2 }, emergency: true,
  });
  assert.strictEqual(res, null);
});

test('tactic output always passes primitive validation', () => {
  const { validatePrimitiveCall } = require('../src/safety/primitiveValidator');
  const cases = [
    { status: status(), milestoneId: 'make_planks', inventory: { oak_log: 2 }, emergency: false },
    { status: status({ target: 'x', craftAs: 'y', requiresTable: true, tableNearby: false, knownStation: { name: 's', distance: 1 } }), milestoneId: 'm', inventory: {}, emergency: false },
  ];
  for (const c of cases) {
    const res = getCurriculumTactic(c);
    if (res) {
      assert.strictEqual(validatePrimitiveCall({ primitive: res.step.name, args: res.step.args }).ok, true);
    }
  }
});

test('tactics are scaffolding only: default autonomous loop does not use them', () => {
  // The deterministic tactics remain available for benchmark/guided
  // tooling, but the autonomous loop must not call them by default.
  const fs = require('fs');
  const loopSrc = fs.readFileSync(require.resolve('../src/agent/loop'), 'utf8');
  assert.ok(!loopSrc.includes('curriculum/tactics'), 'autonomous loop must not use deterministic tactics');
  assert.ok(!loopSrc.includes('getCurriculumTactic'), 'autonomous loop must not call getCurriculumTactic');
});
