'use strict';

function intEnv(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const v = parseInt(String(raw), 10);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}

function floatEnv(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const v = parseFloat(String(raw));
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const s = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function strEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  return String(raw);
}

// MAX_AGENT_STEPS=0 means unlimited (safety-checked by callers).
function getLimits() {
  const rawMaxSteps = process.env.MAX_AGENT_STEPS;
  let maxSteps = intEnv('MAX_AGENT_STEPS', 30, 0, 100000);
  if (rawMaxSteps !== undefined && String(rawMaxSteps).trim() === '0') maxSteps = 0;

  return {
    agentMode: strEnv('AGENT_MODE', 'autonomous').toLowerCase() === 'benchmark' ? 'benchmark' : 'autonomous',
    agentDirective: strEnv(
      'AGENT_DIRECTIVE',
      'Survive, learn, explore and progress through Minecraft autonomously. Decide your own goals from what you observe, what you know and what you have learned from experience. Avoid unnecessary death.'
    ),
    agentGoal: strEnv('AGENT_GOAL', 'Collect 8 logs without dying.'),
    maxSteps,
    decisionDelayMs: intEnv('DECISION_DELAY_MS', 1000, 0, 60000),
    observationRadius: intEnv('OBSERVATION_RADIUS', 24, 2, 64),
    maxNearbyEntities: intEnv('MAX_NEARBY_ENTITIES', 20, 1, 50),
    maxInterestingBlocks: intEnv('MAX_INTERESTING_BLOCKS', 30, 0, 60),
    maxBlockSearchDistance: intEnv('MAX_BLOCK_SEARCH_DISTANCE', 64, 8, 128),
    maxLogCollectionAmount: intEnv('MAX_LOG_COLLECTION_AMOUNT', 8, 1, 64),
    goalLogs: 8,
    maxSkillSteps: intEnv('MAX_SKILL_STEPS', 12, 1, 24),
    maxSkills: intEnv('MAX_SKILLS', 200, 1, 1000),
    maxSemanticMemories: intEnv('MAX_SEMANTIC_MEMORIES', 500, 1, 5000),
    maxEpisodicMemories: intEnv('MAX_EPISODIC_MEMORIES', 500, 1, 5000),
    maxWorldMemories: intEnv('MAX_WORLD_MEMORIES', 500, 1, 5000),
    reflectionEnabled: boolEnv('REFLECTION_ENABLED', true),
    memoryEnabled: boolEnv('MEMORY_ENABLED', true),
    skillGenerationEnabled: boolEnv('SKILL_GENERATION_ENABLED', true),
    primitiveTimeoutMs: intEnv('PRIMITIVE_TIMEOUT_MS', 30000, 1000, 120000),
    skillTimeoutMs: intEnv('SKILL_TIMEOUT_MS', 120000, 5000, 600000),
    blockScanThrottleMs: intEnv('BLOCK_SCAN_THROTTLE_MS', 5000, 0, 60000),
    maxConsecutivePlannerFailures: intEnv('MAX_CONSECUTIVE_PLANNER_FAILURES', 5, 1, 50),
    plannerBackoffBaseMs: intEnv('PLANNER_BACKOFF_BASE_MS', 2000, 0, 60000),
    maxChaseDistance: floatEnv('MAX_CHASE_DISTANCE', 32, 4, 128),
    maxAttackSeconds: intEnv('MAX_ATTACK_SECONDS', 20, 2, 120),
  };
}

function countLogsInInventory(inventory) {
  if (!inventory || typeof inventory !== 'object') return 0;
  let total = 0;
  for (const [name, count] of Object.entries(inventory)) {
    if (typeof name === 'string' && name.endsWith('_log') && Number.isFinite(count)) {
      total += count;
    }
  }
  return total;
}

function isGoalComplete(inventory, required = 8) {
  return countLogsInInventory(inventory) >= required;
}

// Explicit autonomous planner output budget. Measured on DeepSeek V4 Flash
// synthetic decisions: completion tokens p50 319 / p90 684 / p95 826 /
// max 1137 (reasoning tokens inflate these); Nemo max 126. 1536 gives
// ~1.35x headroom over the observed max while preventing runaway output.
// Without an explicit budget the provider default once truncated a valid
// DeepSeek decision mid-JSON.
function autonomousMaxTokens() {
  return intEnv('AUTONOMOUS_MAX_TOKENS', 1536, 128, 8192);
}

// Reflection-v2 outputs are small (summary/lesson/memory), but reasoning
// models spend completion tokens thinking before the JSON. Separate budget
// from the planner so one can be tuned without touching the other.
function reflectionMaxTokens() {
  return intEnv('REFLECTION_MAX_TOKENS', 1024, 128, 8192);
}

// Provider-enforced structured output for the autonomous-v2 shell. A/B
// evidence (sequential, 48 calls/mode, DeepSeek V4 Flash): parse failures
// 3 -> 0, valid 83.3% -> 89.6%, latency p50 10.1s -> 4.1s under a degraded
// provider window; no quality loss; local validation stays authoritative.
// Env kill-switch: STRUCTURED_OUTPUT=0 reverts to plain JSON.
function structuredOutputEnabled() {
  return boolEnv('STRUCTURED_OUTPUT', true);
}

module.exports = { getLimits, countLogsInInventory, isGoalComplete, autonomousMaxTokens, reflectionMaxTokens, structuredOutputEnabled, intEnv, boolEnv, strEnv };
