'use strict';

// Stone-age curriculum milestone DATA. Declarative only: stable IDs,
// descriptions, priorities, prerequisites. No executable code, no
// coordinates, no action sequences — the LLM decides HOW, the trusted
// evaluator (evaluator.js) decides WHEN a milestone is done.
//
// Deliberately small: logs -> planks -> table -> placed table ->
// wooden pickaxe -> cobblestone -> stone pickaxe. Iron and beyond come
// only after this mechanism is proven.

const MILESTONES = [
  {
    id: 'obtain_logs',
    description: 'Obtain basic wood (logs)',
    priority: 60,
    prerequisites: [],
  },
  {
    id: 'make_planks',
    description: 'Craft wooden planks',
    priority: 62,
    prerequisites: ['obtain_logs'],
  },
  {
    id: 'craft_crafting_table',
    description: 'Craft a crafting table',
    priority: 64,
    prerequisites: ['make_planks'],
  },
  {
    id: 'establish_crafting_table',
    description: 'Place a crafting table nearby',
    priority: 66,
    prerequisites: ['craft_crafting_table'],
  },
  {
    id: 'craft_wooden_pickaxe',
    description: 'Craft a wooden pickaxe',
    priority: 68,
    prerequisites: ['establish_crafting_table'],
  },
  {
    id: 'obtain_cobblestone',
    description: 'Obtain cobblestone',
    priority: 70,
    prerequisites: ['craft_wooden_pickaxe'],
  },
  {
    id: 'craft_stone_pickaxe',
    description: 'Craft a stone pickaxe',
    priority: 72,
    prerequisites: ['obtain_cobblestone'],
  },
];

// Material thresholds derived from real recipes (1 log = 4 planks;
// table = 4 planks; pickaxe = 3 planks/cobble + 2 sticks; sticks = 2 planks).
// Small stockpiles only — enough to advance, never arbitrary hoards.
const THRESHOLDS = {
  logs: 4,
  planks: 4,
  cobblestone: 3,
};

module.exports = { MILESTONES, THRESHOLDS };
