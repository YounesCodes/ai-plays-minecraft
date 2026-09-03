'use strict';

// Cognition context builder: compact, bounded context for the planner.
// Never includes raw Mineflayer data, secrets, source code, or full memory DB.

const { DEFAULT_DIRECTIVE } = require('./goals');

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

function buildContext({ directive, goalState, perception, activePlan = [], lastResult = null, recentEvents = [], relevantMemories = {}, availableSkills = [], model = null }) {
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
  };
}

module.exports = { buildContext, summarizePerception };
