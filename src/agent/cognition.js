'use strict';

// Cognition helpers: planner-output validation and LLM-call gating.
// No Mineflayer, no network here — pure decisions over bounded data.

const { validatePrimitiveCall } = require('../safety/primitiveValidator');

function validatePlanStep(step, knownSkillNames = new Set()) {
  if (!step || typeof step !== 'object' || Array.isArray(step)) {
    return { ok: false, error: 'Plan step must be an object' };
  }
  if (step.type === 'primitive') {
    if (typeof step.name !== 'string') return { ok: false, error: 'Primitive step needs a name' };
    const check = validatePrimitiveCall({ primitive: step.name, args: step.args ?? {} });
    if (!check.ok) return { ok: false, error: check.error };
    return { ok: true, value: { type: 'primitive', name: step.name, args: check.value.args } };
  }
  if (step.type === 'skill') {
    if (typeof step.name !== 'string' || !step.name) {
      return { ok: false, error: 'Skill step needs a name' };
    }
    // Always enforced, even when the library is empty: an empty library
    // means NO skill steps are legal (use primitives). The old size>0
    // bypass let the planner hallucinate skill names that failed later
    // at execution, looping on the same unknown skill every turn.
    if (!knownSkillNames.has(step.name)) {
      const known = [...knownSkillNames].slice(0, 10).join(', ') || '(none yet — use a primitive step instead)';
      return { ok: false, error: `Unknown skill: ${step.name}. Known skills: ${known}` };
    }
    if (step.args !== undefined && (typeof step.args !== 'object' || step.args === null || Array.isArray(step.args))) {
      return { ok: false, error: 'Skill args must be an object' };
    }
    for (const [k, v] of Object.entries(step.args || {})) {
      if (v !== null && typeof v === 'object') {
        return { ok: false, error: `Skill arg "${k}" must be a scalar` };
      }
    }
    return { ok: true, value: { type: 'skill', name: step.name, args: { ...(step.args || {}) } } };
  }
  return { ok: false, error: `Unknown step type: ${step.type}` };
}

// Slim autonomous hot-path decision (contract autonomous-v2): one compact
// strategic choice per tick. The rich v1 fields (goal object every turn,
// plan[], proposeSkill, memoryToCreate) proved too unreliable for small
// models, so they are rejected here — skill/memory/reflection happen
// through their own separate paths, not inside every reasoning turn.
function validateAutonomousDecision(output, options = {}) {
  const knownSkillNames = options.knownSkillNames instanceof Set ? options.knownSkillNames : new Set(options.knownSkillNames || []);
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return { ok: false, error: 'Decision must be an object' };
  }
  for (const key of Object.keys(output)) {
    if (!['assessment', 'goalChange', 'nextStep'].includes(key)) {
      return { ok: false, error: `Unexpected decision field: "${key}"` };
    }
  }
  if (typeof output.assessment !== 'string' || !output.assessment.trim() || output.assessment.length > 500) {
    return { ok: false, error: 'assessment must be a non-empty string (max 500 chars)' };
  }
  let goalChange = null;
  if (output.goalChange !== undefined && output.goalChange !== null) {
    const g = output.goalChange;
    if (!g || typeof g !== 'object' || Array.isArray(g)) {
      return { ok: false, error: 'goalChange must be an object or null' };
    }
    for (const key of Object.keys(g)) {
      if (!['description', 'priority', 'reason'].includes(key)) {
        return { ok: false, error: `Unexpected goalChange field: "${key}"` };
      }
    }
    if (typeof g.description !== 'string' || !g.description.trim() || g.description.length > 200) {
      return { ok: false, error: 'goalChange.description must be a non-empty string (max 200 chars)' };
    }
    let priority = Number(g.priority);
    if (!Number.isFinite(priority)) priority = 70;
    priority = Math.max(0, Math.min(100, priority));
    goalChange = {
      description: g.description.trim(),
      priority,
      reason: String(g.reason || '').slice(0, 300),
    };
  }
  if (!output.nextStep) return { ok: false, error: 'nextStep is required' };
  const next = validatePlanStep(output.nextStep, knownSkillNames);
  if (!next.ok) return { ok: false, error: `Invalid nextStep: ${next.error}` };
  return {
    ok: true,
    value: { assessment: output.assessment.trim(), goalChange, nextStep: next.value },
  };
}

// Decide whether an LLM call is required this tick. Deterministic work (path
// progress, in-skill waits) should NOT trigger planning.
function needsPlanner({ interrupt = null, goalState = null, lastResult = null, ticksSincePlan = 0, consecutiveFailures = 0, significantEvent = null } = {}) {
  if (interrupt) return { needed: true, reason: `interrupt:${interrupt.type}` };
  if (significantEvent) return { needed: true, reason: `event:${significantEvent.type || 'significant'}` };
  if (!goalState?.currentGoal) return { needed: true, reason: 'no-goal' };
  if (lastResult && lastResult.ok === false) {
    if (consecutiveFailures >= 2 || ticksSincePlan >= 1) return { needed: true, reason: 'failure-replan' };
  }
  if (ticksSincePlan >= 3) return { needed: true, reason: 'periodic-review' };
  if (lastResult?.goalCompleted) return { needed: true, reason: 'goal-completed' };
  return { needed: false, reason: 'deterministic-progress' };
}

// Classify invalid planner responses for telemetry (model + category, never
// secrets). Lets us measure whether the rich schema is too ambitious for
// small models before redesigning the contract.
function categorizePlannerError(err) {
  const m = String((err && err.message) || err || '');
  if (/not valid JSON|invalid JSON|Unexpected token|contained no JSON/i.test(m)) return 'parse-failure';
  if (/Unknown primitive/i.test(m)) return 'unknown-primitive';
  if (/Unknown skill/i.test(m)) return 'unknown-skill';
  if (/Unexpected decision field|Unexpected goalChange field/i.test(m)) return 'unexpected-fields';
  if (/too many steps/i.test(m)) return 'plan-too-long';
  if (/Skill .*must be|Skill has/i.test(m)) return 'skill-schema';
  if (/unexpected argument|Invalid plan step|Invalid nextStep|must be one of|destination must be|goalChange/i.test(m)) {
    return 'invalid-args';
  }
  if (/Missing|required|must be/i.test(m)) return 'missing-fields';
  return 'other';
}

module.exports = { validatePlanStep, validateAutonomousDecision, needsPlanner, categorizePlannerError };
