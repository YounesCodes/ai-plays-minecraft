'use strict';

// Cognition context builder: compact, bounded context for the planner.
// Never includes raw Mineflayer data, secrets, source code, or full memory DB.

const { DEFAULT_DIRECTIVE } = require('./goals');
const { MELEE_PRIORITY } = require('../primitives/combat');
const { FOOD_PRIORITY } = require('../primitives/survival');

// Entities are presented with an explicit entityId so the model copies a
// valid ID straight from context (attack_entity.entityId) instead of
// inferring one from coordinates or names. `id` is kept alongside for
// lower-level compatibility — both refer to the same Mineflayer entity.
function groundEntities(list) {
  return (list || []).slice(0, 20).map((e) => {
    if (!e || typeof e !== 'object') return e;
    const entityId = e.entityId ?? e.id ?? null;
    return { ...e, entityId };
  });
}

function summarizePerception(perception) {
  if (!perception) return null;
  return {
    self: perception.self || { health: perception.health, food: perception.food, position: perception.position },
    equipment: perception.equipment || null,
    inventory: perception.inventory || {},
    environment: perception.environment || { timeOfDay: perception.timeOfDay },
    nearbyEntities: groundEntities(perception.nearbyEntitiesDetailed || perception.nearbyEntities),
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

// Compact opportunity summary derived from the bounded interestingBlocks
// scan (category comes from perception's single classification source).
// Groups duplicates so 12 trunk blocks read as one line, not twelve.
// Water/lava are terrain, not acquisition opportunities, and are excluded.
function summarizeOpportunities(perception, maxGroups = 6) {
  const out = [];
  try {
    const blocks = (perception && perception.interestingBlocks) || [];
    const groups = new Map();
    for (const b of blocks) {
      if (!b || typeof b.type !== 'string') continue;
      const cat = b.category || 'other';
      if (cat === 'water' || cat === 'lava') continue;
      const d = typeof b.distance === 'number' ? b.distance : Infinity;
      const g = groups.get(cat);
      if (!g) {
        groups.set(cat, { category: cat, nearestType: b.type, distance: d, countObserved: 1 });
      } else {
        g.countObserved += 1;
        if (d < g.distance) {
          g.distance = d;
          g.nearestType = b.type;
        }
      }
    }
    const arr = [...groups.values()];
    arr.sort((a, b) => a.distance - b.distance);
    for (const g of arr.slice(0, maxGroups)) {
      out.push({
        category: g.category,
        nearestType: g.nearestType,
        distance: Number.isFinite(g.distance) ? g.distance : null,
        countObserved: g.countObserved,
      });
    }
  } catch {
    // ignore; opportunities are advisory
  }
  return out;
}

function buildContext({ directive, goalState, perception, lastResult = null, recentEvents = [], relevantMemories = {}, availableSkills = [], model = null, exploration = null, deathSignal = null, actionHistory = [], stagnation = null, oscillation = null, currentStep = null }) {
  // Factual goal age in cognition turns. Never used to force expiry or
  // change — the model owns goal lifetime.
  const goalAgeSteps = goalState?.currentGoal
    && Number.isFinite(Number(goalState.currentGoal.activatedAtStep))
    && Number.isFinite(Number(currentStep))
    ? Math.max(0, Math.floor(Number(currentStep) - Number(goalState.currentGoal.activatedAtStep)))
    : null;
  return {
    directive: directive || process.env.AGENT_DIRECTIVE || DEFAULT_DIRECTIVE,
    currentGoal: goalState?.currentGoal || null,
    goalAgeSteps,
    subgoals: goalState?.subgoals || [],
    suspendedGoal: goalState?.suspendedGoal || null,
    state: summarizePerception(perception),
    nearbyOpportunities: summarizeOpportunities(perception),
    actionHistory: Array.isArray(actionHistory) ? actionHistory.slice(-6) : [],
    stagnation: stagnation && stagnation.detected ? stagnation : { detected: false },
    oscillation: oscillation && oscillation.detected ? oscillation : { detected: false },
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

module.exports = { buildContext, summarizePerception, summarizeSurvival, summarizeOpportunities };
