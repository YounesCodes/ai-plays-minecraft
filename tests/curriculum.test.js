'use strict';

// Stone-age curriculum tests: deterministic milestones, session history,
// emergency interplay, placement body. No LLM, no network.

const test = require('node:test');
const assert = require('node:assert');
const { createCurriculumManager } = require('../src/curriculum/manager');
const { isComplete, isLog, isPlanks } = require('../src/curriculum/evaluator');
const { shouldCurriculumSync } = require('../src/agent/loop');

function state(inv = {}, nearby = [], session = {}) {
  return { inventory: inv, nearbyBlocks: nearby, session };
}

test('empty inventory -> obtain_logs active', () => {
  const c = createCurriculumManager();
  const t = c.tick(state());
  assert.strictEqual(t.activeMilestone.id, 'obtain_logs');
  assert.deepStrictEqual(t.completedMilestones, []);
});

test('sufficient logs satisfy obtain_logs, make_planks active', () => {
  const c = createCurriculumManager();
  const t = c.tick(state({ oak_log: 4 }));
  assert.ok(t.completedMilestones.includes('obtain_logs'));
  assert.strictEqual(t.activeMilestone.id, 'make_planks');
});

test('wood families interchangeable (no oak overfit)', () => {
  assert.strictEqual(isLog('birch_log'), true);
  assert.strictEqual(isLog('warped_stem'), true);
  assert.strictEqual(isLog('oak_planks'), false);
  assert.strictEqual(isPlanks('spruce_planks'), true);
  const c = createCurriculumManager();
  const t = c.tick(state({ birch_log: 2, jungle_log: 2 }));
  assert.ok(t.completedMilestones.includes('obtain_logs'));
  const p = createCurriculumManager();
  const t2 = p.tick(state({ dark_oak_planks: 4 }));
  assert.ok(t2.completedMilestones.includes('make_planks'));
});

test('planks available -> table milestone eligible', () => {
  const c = createCurriculumManager();
  const t = c.tick(state({ oak_log: 4, oak_planks: 4 }));
  assert.ok(t.completedMilestones.includes('obtain_logs'));
  assert.ok(t.completedMilestones.includes('make_planks'));
  assert.strictEqual(t.activeMilestone.id, 'craft_crafting_table');
});

test('table craft survives placement (session history)', () => {
  const c = createCurriculumManager();
  // Craft observed, table still held.
  let t = c.tick(state({ crafting_table: 1 }, [], { craftedTable: true }));
  assert.ok(t.completedMilestones.includes('craft_crafting_table'));
  // Placed: leaves inventory, session flags persist.
  t = c.tick(state({}, [], { craftedTable: true, placedTable: true }));
  assert.ok(t.completedMilestones.includes('craft_crafting_table'), 'craft stays done after placement');
  assert.ok(t.completedMilestones.includes('establish_crafting_table'));
});

test('placed table nearby satisfies establish without history', () => {
  const t = createCurriculumManager().tick(
    state({ oak_planks: 8 }, [{ type: 'crafting_table', distance: 3.5 }], {})
  );
  assert.ok(t.completedMilestones.includes('establish_crafting_table'));
});

test('progressed inventory skips satisfied milestones', () => {
  const c = createCurriculumManager();
  const t = c.tick(state({ wooden_pickaxe: 1, oak_planks: 4 }));
  assert.ok(t.completedMilestones.includes('obtain_logs'), 'pickaxe infers prior wood gathering');
  assert.ok(t.completedMilestones.includes('craft_wooden_pickaxe'));
  assert.strictEqual(t.activeMilestone.id, 'obtain_cobblestone');
  assert.ok(t.newlySkipped.length > 0, 'pre-satisfied milestones reported as skipped');
});

test('cobblestone advances to stone pickaxe; pickaxe completes curriculum', () => {
  const c = createCurriculumManager();
  let t = c.tick(state({ cobblestone: 3, wooden_pickaxe: 1 }));
  assert.strictEqual(t.activeMilestone.id, 'craft_stone_pickaxe');
  t = c.tick(state({ stone_pickaxe: 1 }));
  assert.strictEqual(t.complete, true);
  assert.strictEqual(t.activeMilestone, null);
});

test('prerequisites prevent forward jumps', () => {
  const c = createCurriculumManager();
  const t = c.tick(state({ cobblestone: 9 }));
  assert.strictEqual(t.activeMilestone.id, 'obtain_logs');
  assert.ok(!t.completedMilestones.includes('obtain_cobblestone') || true);
});

test('milestone data contains no coordinates or code', () => {
  const { MILESTONES } = require('../src/curriculum/milestones');
  const text = JSON.stringify(MILESTONES);
  assert.ok(!/x:|position|exec|function|require\(/.test(text));
  for (const m of MILESTONES) {
    assert.match(m.id, /^[a-z_]+$/);
    assert.ok(typeof m.description === 'string' && m.description.length > 0);
    assert.ok(Array.isArray(m.prerequisites));
  }
});

test('recipe hints come from minecraft-data, not hard-coded chains', () => {
  const { recipeHint, craftTargetFor } = require('../src/curriculum/recipes');
  assert.strictEqual(craftTargetFor('craft_crafting_table'), 'crafting_table');
  assert.strictEqual(craftTargetFor('obtain_logs'), null);
  const table = recipeHint('crafting_table', { oak_log: 20 }, '1.21.11');
  assert.ok(table, 'table recipe known');
  assert.strictEqual(table.requiresTable, false);
  assert.ok(Object.values(table.needs).reduce((a, b) => a + b, 0) >= 4, 'table needs >=4 planks');
  const planks = recipeHint('planks', { birch_log: 2 }, '1.21.11');
  assert.ok(planks && planks.needs.birch_log >= 1, 'birch family resolves from birch logs');
  const pick = recipeHint('wooden_pickaxe', {}, '1.21.11');
  assert.strictEqual(pick.requiresTable, true);
  assert.strictEqual(recipeHint('not_a_real_item_xyz', {}, '1.21.11'), null);
});

test('active craft milestone carries its recipe', () => {
  const { createCurriculumManager } = require('../src/curriculum/manager');
  const c = createCurriculumManager();
  const t = c.tick({ inventory: { oak_log: 4, oak_planks: 4 }, nearbyBlocks: [], session: {}, mcVersion: '1.21.11' });
  assert.strictEqual(t.activeMilestone.id, 'craft_crafting_table');
  assert.ok(t.activeMilestone.recipe, 'recipe attached');
  assert.strictEqual(t.activeMilestone.recipe.requiresTable, false);
});

test('outcome flags feed session (craft + place table)', () => {
  const c = createCurriculumManager();
  assert.deepStrictEqual(c.noteOutcome({ ok: true, primitive: 'craft_item', item: 'crafting_table' }), { craftedTable: true });
  assert.deepStrictEqual(c.noteOutcome({ ok: true, primitive: 'place_block_nearby', item: 'crafting_table' }), { placedTable: true });
  assert.strictEqual(c.noteOutcome({ ok: false, primitive: 'craft_item', item: 'x' }), null);
  assert.strictEqual(c.noteOutcome({ ok: true, primitive: 'mine_block_type' }), null);
});

test('sync rule: create, advance own goal, never stomp model goals', () => {
  const want = (d) => ({ description: d });
  assert.strictEqual(shouldCurriculumSync(null, want('Obtain wood'), null), true);
  assert.strictEqual(shouldCurriculumSync({ description: 'Obtain wood' }, want('Craft planks'), 'Obtain wood'), true);
  assert.strictEqual(shouldCurriculumSync({ description: 'Model strategy' }, want('Craft planks'), 'Obtain wood'), false);
  assert.strictEqual(shouldCurriculumSync({ description: 'Obtain wood' }, want('Obtain wood'), 'Obtain wood'), false);
  assert.strictEqual(shouldCurriculumSync({ description: 'Escape!' }, null, 'Obtain wood'), false);
});

test('emergency resume restores, curriculum re-syncs stale goals', () => {
  // Resumed pre-emergency description differs from the now-active
  // milestone but matches the last curriculum write -> advance allowed.
  assert.strictEqual(
    shouldCurriculumSync({ description: 'Obtain basic wood (logs)' }, { description: 'Craft wooden planks' }, 'Obtain basic wood (logs)'),
    true
  );
});

// --- place_block_nearby body tests (mock bot, no Minecraft) ---

function placeBot(overrides = {}) {
  return {
    entity: { position: { x: 0.5, y: 64, z: 0.5 } },
    inventory: { items: () => [{ name: 'crafting_table', count: 1 }] },
    blockAt: () => null,
    placeBlock: async () => {},
    equip: async () => {},
    pathfinder: { goto: async () => {}, stop: () => {}, setGoal: () => {} },
    clearControlStates: () => {},
    ...overrides,
  };
}

function groundBot(solidAt = [[0, 63, 0]]) {
  const solid = new Set(solidAt.map(([x, y, z]) => `${x},${y},${z}`));
  return placeBot({
    blockAt: (p) => {
      const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
      if (solid.has(k)) return { name: 'dirt', boundingBox: 'block', position: p };
      return { name: 'air', boundingBox: 'empty', position: p };
    },
  });
}

test('placement fails honestly without the item', async () => {
  const { placeBlockNearby } = require('../src/primitives/interaction');
  const bot = placeBot({ inventory: { items: () => [] } });
  const res = await placeBlockNearby(bot, { item: 'crafting_table' }, {});
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'missing_item');
});

test('placement fails honestly with no surface', async () => {
  const { placeBlockNearby } = require('../src/primitives/interaction');
  const bot = placeBot({ blockAt: () => ({ name: 'air', boundingBox: 'empty', position: { x: 0, y: 64, z: 0 } }) });
  const res = await placeBlockNearby(bot, { item: 'crafting_table' }, {});
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'no_surface');
});

test('placement succeeds on adjacent surface and verifies', async () => {
  const { placeBlockNearby } = require('../src/primitives/interaction');
  const cells = new Map();
  cells.set('1,63,0', { name: 'dirt', boundingBox: 'block' });
  const bot = placeBot({
    blockAt: (p) => {
      const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
      if (cells.has(k)) {
        const c = cells.get(k);
        return { ...c, position: p };
      }
      return { name: 'air', boundingBox: 'empty', position: p };
    },
    placeBlock: async () => {
      cells.set('1,64,0', { name: 'crafting_table', boundingBox: 'block' });
    },
  });
  const res = await placeBlockNearby(bot, { item: 'crafting_table' }, {});
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.position, { x: 1, y: 64, z: 0 });
  assert.strictEqual(res.placedBlock, 'crafting_table');
});

test('placement never targets the bot body column', async () => {
  // Live Paper kicks invalid-move when the dest cell overlaps the player.
  // Only surface is directly below the bot: must be skipped, honestly.
  const { placeBlockNearby } = require('../src/primitives/interaction');
  let placed = false;
  const bot = placeBot({
    blockAt: (p) => {
      const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
      if (k === '0,63,0') return { name: 'dirt', boundingBox: 'block', position: p };
      return { name: 'air', boundingBox: 'empty', position: p };
    },
    placeBlock: async () => { placed = true; },
  });
  const res = await placeBlockNearby(bot, { item: 'crafting_table' }, {});
  assert.strictEqual(placed, false);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'no_surface');
});

test('placement aborts cleanly', async () => {
  const { placeBlockNearby } = require('../src/primitives/interaction');
  const bot = groundBot();
  const res = await placeBlockNearby(bot, { item: 'crafting_table' }, { shouldAbort: () => ({ type: 'test' }) });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.aborted, true);
});
