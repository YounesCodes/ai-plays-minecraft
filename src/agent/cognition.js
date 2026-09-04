'use strict';

// Cognition helpers: planner-output validation and LLM-call gating.
// No Mineflayer, no network here — pure decisions over bounded data.

const { validatePrimitiveCall } = require('../safety/primitiveValidator');
const { validateSkill } = require('../safety/skillValidator');

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
    if (knownSkillNames.size > 0 && !knownSkillNames.has(step.name)) {
      return { ok: false, error: `Unknown skill: ${step.name}` };
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

function validatePlannerOutput(output, options = {}) {
  const knownSkillNames = options.knownSkillNames instanceof Set ? options.knownSkillNames : new Set(options.knownSkillNames || []);
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return { ok: false, error: 'Planner output must be an object' };
  }
  for (const key of Object.keys(output)) {
    if (!['assessment', 'goal', 'plan', 'nextStep', 'proposeSkill', 'memoryToCreate'].includes(key)) {
      return { ok: false, error: `Unexpected planner field: "${key}"` };
    }
  }
  const assessment = output.assessment || {};
  if (typeof assessment.summary !== 'string' || !assessment.summary.trim() || assessment.summary.length > 1000) {
    return { ok: false, error: 'assessment.summary must be a non-empty string (max 1000 chars)' };
  }
  const goal = output.goal || {};
  if (typeof goal.description !== 'string' || !goal.description.trim() || goal.description.length > 300) {
    return { ok: false, error: 'goal.description must be a non-empty string (max 300 chars)' };
  }
  let priority = Number(goal.priority);
  if (!Number.isFinite(priority)) priority = 50;
  priority = Math.max(0, Math.min(100, priority));

  let plan = [];
  if (output.plan !== undefined && output.plan !== null) {
    if (!Array.isArray(output.plan)) return { ok: false, error: 'plan must be an array' };
    if (output.plan.length > 12) return { ok: false, error: 'plan has too many steps (max 12)' };
    for (const s of output.plan) {
      const checked = validatePlanStep(s, knownSkillNames);
      if (!checked.ok) return { ok: false, error: `Invalid plan step: ${checked.error}` };
      plan.push(checked.value);
    }
  }
  if (!output.nextStep) return { ok: false, error: 'nextStep is required' };
  const next = validatePlanStep(output.nextStep, knownSkillNames);
  if (!next.ok) return { ok: false, error: `Invalid nextStep: ${next.error}` };

  let proposeSkill = null;
  if (output.proposeSkill !== undefined && output.proposeSkill !== null) {
    const checked = validateSkill(output.proposeSkill);
    if (!checked.ok) return { ok: false, error: `Invalid proposeSkill: ${checked.error}` };
    proposeSkill = output.proposeSkill;
  }

  let memoryToCreate = null;
  if (output.memoryToCreate !== undefined && output.memoryToCreate !== null) {
    const m = output.memoryToCreate;
    if (!m || typeof m !== 'object' || Array.isArray(m)) {
      return { ok: false, error: 'memoryToCreate must be an object or null' };
    }
    if (!['semantic', 'episodic', 'world'].includes(m.kind)) {
      return { ok: false, error: 'memoryToCreate.kind must be semantic|episodic|world' };
    }
    memoryToCreate = m;
  }

  return {
    ok: true,
    value: {
      assessment: { summary: assessment.summary.trim(), immediateThreat: assessment.immediateThreat ?? null },
      goal: {
        description: goal.description.trim(),
        priority,
        reason: String(goal.reason || '').slice(0, 300),
        changeGoal: goal.changeGoal === true,
      },
      plan,
      nextStep: next.value,
      proposeSkill,
      memoryToCreate,
    },
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
  if (/not valid JSON|invalid JSON|Unexpected token/i.test(m)) return 'parse-failure';
  if (/Unknown primitive/i.test(m)) return 'unknown-primitive';
  if (/Unknown skill/i.test(m)) return 'unknown-skill';
  if (/too many steps/i.test(m)) return 'plan-too-long';
  if (/Skill .*must be|Skill has/i.test(m)) return 'skill-schema';
  if (/missing required/i.test(m)) return 'missing-fields';
  if (/unexpected argument|Invalid plan step|Invalid nextStep|must be one of|destination must be/i.test(m)) {
    return 'invalid-args';
  }
  if (/Missing|required|must be/i.test(m)) return 'missing-fields';
  return 'other';
}

module.exports = { validatePlanStep, validatePlannerOutput, needsPlanner, categorizePlannerError };
