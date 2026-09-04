'use strict';

// Cognition context builder: compact, bounded context for the planner.
// Never includes raw Mineflayer data, secrets, source code, or full memory DB.

const { DEFAULT_DIRECTIVE } = require('./goals');
const { MELEE_PRIORITY } = require('../primitives/combat');
const { FOOD_PRIORITY } = require('../primitives/survival');

function summarizePerception(perception) {
  if (!perception) return null;
  return {
    self: perception.self || { health: perception.health, food: perception.food, position: perception.position },
    equipment: perception.equipment || null,
    inventory: perception.inventory || {},
    environment: perception.environment || { timeOfDay: perception.timeOfDay },
    nearbyEntities: (perception.nearbyEntitiesDetailed || perception.nearbyEntities || []).slice(0, 20),
    interestingBlocks: (perception.interestingBlocks || []).slice(0, 30),
    knownLocationsNearby: (perception.knownLocationsNearby || []).slice(0, 8),
  };
}

// Reflex-level survival snapshot for the planner: cheap facts that keep the
// LLM from missing the obvious (unarmed at night with a zombie nearby).
// Derived from current perception only — never from stale memory.
function summarizeSurvival(perception) {
  const inventory = (perception && (perception.inventory || (perception.self && perception.self.inventory))) || {};
  const names = Object.keys(inventory);
  const meleeSet = new Set(MELEE_PRIORITY || []);
  const unarmed = !names.some((n) => meleeSet.has(n) || /(sword|axe)$/.test(n));
  const foodSet = new Set(FOOD_PRIORITY || []);
  const foodAvailable = names.some((n) => foodSet.has(n));
  const env = (perception && perception.environment) || {};
  const night = env.timeCategory === 'night';
  const entities = (perception && (perception.nearbyEntitiesDetailed || perception.nearbyEntities)) || [];
  let nearestHostile = null;
  for (const e of entities) {
    if (!e || e.hostile !== true) continue;
    if (typeof e.distance !== 'number') continue;
    if (!nearestHostile || e.distance < nearestHostile.distance) {
      nearestHostile = { type: e.type || e.name || 'hostile', distance: e.distance };
    }
  }
  return { unarmed, foodAvailable, night, nearestHostile };
}

function buildContext({ directive, goalState, perception, activePlan = [], lastResult = null, recentEvents = [], relevantMemories = {}, availableSkills = [], model = null, exploration = null, deathSignal = null }) {
  return {
    directive: directive || process.env.AGENT_DIRECTIVE || DEFAULT_DIRECTIVE,
    currentGoal: goalState?.currentGoal || null,
    subgoals: goalState?.subgoals || [],
    suspendedGoal: goalState?.suspendedGoal || null,
    state: summarizePerception(perception),
    activePlan: Array.isArray(activePlan) ? activePlan.slice(0, 12) : [],
    lastResult: lastResult ? JSON.parse(JSON.stringify(lastResult, (k, v) => (typeof v === 'function' ? undefined : v))) : null,
    recentImportantEvents: Array.isArray(recentEvents) ? recentEvents.slice(-8) : [],
    relevantMemories: {
      semantic: (relevantMemories.semantic || []).slice(0, 6),
      episodic: (relevantMemories.episodic || []).slice(0, 4),
      procedural: (relevantMemories.procedural || []).slice(0, 4),
      world: (relevantMemories.world || []).slice(0, 6),
    },
    availableRelevantSkills: (availableSkills || []).slice(0, 10).map((s) => ({
      id: s.id, name: s.name, description: s.description,
      parameters: s.parameters, score: s.score,
      successCount: s.successCount, failureCount: s.failureCount,
    })),
    model,
    survival: summarizeSurvival(perception),
    exploration: exploration || null,
    deathSignal: deathSignal || null,
  };
}

module.exports = { buildContext, summarizePerception, summarizeSurvival };
