#!/usr/bin/env node
'use strict';

// Workstation planner scenarios A-D (Phase 14): real curriculum manager
// states -> real prompt -> real OpenRouter model -> real validator.
// Judges whether the decision ADVANCES the milestone (lenient rubric).
// Never prints secrets.

const { createCurriculumManager } = require('../src/curriculum/manager');
const { planAutonomous, AUTONOMOUS_CONTRACT } = require('../src/agent/planner');
const { categorizePlannerError } = require('../src/agent/cognition');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const CALLS_PER_SCENARIO = parseInt(arg('--calls', '4'), 10);

function basePerception(over = {}) {
  return {
    self: { health: 20, food: 20, position: { x: 0, y: 64, z: 0 } },
    equipment: {},
    inventory: {},
    environment: { timeOfDay: 6000, timeCategory: 'day' },
    nearbyEntities: [],
    nearbyEntitiesDetailed: [],
    interestingBlocks: [],
    knownLocationsNearby: [],
    ...over,
  };
}

function contextFor({ inventory, nearbyBlocks, worldLocations, botPos, lastResult, exploration }) {
  const { buildContext } = require('../src/agent/context');
  const c = createCurriculumManager();
  const tick = c.tick({ inventory, nearbyBlocks, session: {}, mcVersion: '1.21.11', worldLocations, botPosition: botPos });
  // Guided-mode diagnostic tooling: this script intentionally injects
  // milestone context into the planner context. Default autonomous operation
  // does NOT do this (buildContext no longer carries curriculum state).
  const context = buildContext({
    directive: 'Survive and progress.',
    goalState: { currentGoal: { description: tick.activeMilestone ? tick.activeMilestone.description : 'done' }, subgoals: [], suspendedGoal: null },
    perception: basePerception({ inventory, interestingBlocks: nearbyBlocks }),
    lastResult,
    recentEvents: [],
    relevantMemories: { semantic: [], episodic: [], procedural: [], world: [] },
    availableSkills: [],
    exploration: exploration || null,
    deathSignal: null,
    actionHistory: [],
    stagnation: { detected: false },
    oscillation: { detected: false },
  });
  context.curriculum = { activeMilestone: tick.activeMilestone, completedMilestones: tick.completedMilestones };
  return context;
}

// Rubrics: does the decision move toward the milestone?
function judges(scenario, decision) {
  const n = decision.nextStep;
  if (scenario === 'A') {
    return (n.type === 'primitive' && (n.name === 'craft_item' || n.name === 'mine_block_type' || n.name === 'find_block')) || 'want craft/mine/find, got ' + n.name;
  }
  if (scenario === 'B') {
    if (n.type === 'primitive' && ['craft_item', 'place_block_nearby', 'mine_block_type', 'find_block'].includes(n.name)) return true;
    if (n.type === 'primitive' && n.name === 'explore') return 'left a ready workstation to explore';
    return 'want craft/place/mine/find, got ' + n.name;
  }
  if (scenario === 'C') {
    if (n.type === 'primitive' && n.name === 'move_to_known_location') return true;
    if (n.type === 'primitive' && ['craft_item', 'place_block_nearby', 'find_block'].includes(n.name)) return true;
    return 'want return-to-station, got ' + n.name;
  }
  if (scenario === 'D') {
    if (n.type === 'primitive' && n.name === 'place_block_nearby') return true;
    if (n.type === 'primitive' && ['craft_item', 'find_block', 'mine_block_type'].includes(n.name)) return true;
    return 'want place/craft/find/mine, got ' + n.name;
  }
  return 'unknown scenario';
}

async function main() {
  const scenarios = {
    A: () => contextFor({
      inventory: { oak_log: 6 },
      nearbyBlocks: [{ type: 'oak_log', category: 'log', position: { x: 2, y: 64, z: 0 }, distance: 2.5 }],
      worldLocations: [], botPos: { x: 0, y: 64, z: 0 },
      lastResult: { ok: true, primitive: 'mine_block_type', block: 'oak_log', broken: 2 },
    }),
    B: () => contextFor({
      inventory: { oak_planks: 5, stick: 4 },
      nearbyBlocks: [{ type: 'crafting_table', category: 'crafting_table', position: { x: 2, y: 64, z: 1 }, distance: 3.0 }],
      worldLocations: [{ name: 'crafting_station', position: { x: 2, y: 64, z: 1 }, metadata: { kind: 'workstation', block: 'crafting_table' } }],
      botPos: { x: 0, y: 64, z: 0 },
      lastResult: { ok: true, primitive: 'find_block', blockType: 'crafting_table' },
    }),
    C: () => contextFor({
      inventory: { oak_planks: 5, stick: 4 },
      nearbyBlocks: [],
      worldLocations: [{ name: 'crafting_station', position: { x: 40, y: 64, z: 0 }, metadata: { kind: 'workstation', block: 'crafting_table' } }],
      botPos: { x: 0, y: 64, z: 0 },
      lastResult: { ok: false, primitive: 'craft_item', item: 'wooden_pickaxe', reason: 'crafting_table_required' },
    }),
    D: () => contextFor({
      inventory: { oak_planks: 5, stick: 4, crafting_table: 1 },
      nearbyBlocks: [],
      worldLocations: [],
      botPos: { x: 0, y: 64, z: 0 },
      lastResult: { ok: false, primitive: 'craft_item', item: 'wooden_pickaxe', reason: 'crafting_table_required' },
    }),
  };
  const stats = { valid: 0, invalid: 0, categories: {}, advancing: 0, total: 0, byScenario: {} };
  console.log(JSON.stringify({ eval: 'workstation-decisions', contract: AUTONOMOUS_CONTRACT, model: process.env.OPENROUTER_MODEL || null }));
  for (const [name, build] of Object.entries(scenarios)) {
    stats.byScenario[name] = { advancing: 0, total: 0, notes: [] };
    for (let i = 0; i < CALLS_PER_SCENARIO; i++) {
      stats.total += 1;
      stats.byScenario[name].total += 1;
      try {
        const { decision } = await planAutonomous({ context: build(), knownSkillNames: [], temperature: 0.4 });
        stats.valid += 1;
        const j = judges(name, decision);
        if (j === true) {
          stats.advancing += 1;
          stats.byScenario[name].advancing += 1;
        } else {
          stats.byScenario[name].notes.push(j);
        }
        console.log(JSON.stringify({ scenario: name, call: i + 1, ok: true, next: `${decision.nextStep.type}:${decision.nextStep.name}`, advancing: j === true }));
      } catch (err) {
        const cat = /non-JSON|invalid JSON/i.test(String(err && err.message)) ? 'parse-failure' : categorizePlannerError(err);
        stats.invalid += 1;
        stats.categories[cat] = (stats.categories[cat] || 0) + 1;
        console.log(JSON.stringify({ scenario: name, call: i + 1, ok: false, category: cat }));
      }
    }
  }
  console.log(JSON.stringify({ summary: true, ...stats, invalidPct: Math.round((stats.invalid / Math.max(1, stats.total)) * 1000) / 10, advancingPct: Math.round((stats.advancing / Math.max(1, stats.valid)) * 1000) / 10 }));
}

main().catch((e) => { console.error(JSON.stringify({ error: String((e && e.message) || e).slice(0, 200) })); process.exit(1); });
