'use strict';

// Skill executor: runs validated declarative skills step-by-step through the
// trusted primitive registry. Handles $param substitution, per-step timeout,
// fail-fast with structured outcome, and cooperative interrupt abortion.

const { validateSkill } = require('../safety/skillValidator');
const { executePrimitive } = require('../primitives');

function substituteArgs(stepArgs, params, provided) {
  const out = {};
  for (const [k, v] of Object.entries(stepArgs || {})) {
    if (typeof v === 'string' && v.startsWith('$')) {
      const ref = v.slice(1);
      if (!params.includes(ref)) {
        return { ok: false, error: `Unknown parameter reference "${v}"` };
      }
      if (provided[ref] === undefined) {
        return { ok: false, error: `Missing parameter value for "${ref}"` };
      }
      out[k] = provided[ref];
    } else {
      out[k] = v;
    }
  }
  return { ok: true, value: out };
}

function inventoryDelta(before, after) {
  const delta = {};
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const k of keys) {
    const d = (after?.[k] || 0) - (before?.[k] || 0);
    if (d !== 0) delta[k] = d;
  }
  return delta;
}

function snapshotInventory(bot) {
  const map = {};
  try {
    for (const item of bot.inventory.items()) {
      if (item && item.name) map[item.name] = (map[item.name] || 0) + item.count;
    }
  } catch {
    // ignore
  }
  return map;
}

// options: { timeoutMs, stepTimeoutMs, shouldAbort() -> interrupt|null }
async function executeSkill(bot, skill, args = {}, options = {}) {
  const check = validateSkill(skill);
  if (!check.ok) {
    return { ok: false, skillId: skill?.id || null, error: `Invalid skill: ${check.error}`, completedSteps: 0, failedStep: 0 };
  }
  const started = Date.now();
  const skillTimeout = options.timeoutMs || parseInt(process.env.SKILL_TIMEOUT_MS || '120000', 10) || 120000;
  const stepTimeout = options.stepTimeoutMs || parseInt(process.env.PRIMITIVE_TIMEOUT_MS || '30000', 10) || 30000;

  const healthBefore = typeof bot.health === 'number' ? bot.health : null;
  const foodBefore = typeof bot.food === 'number' ? bot.food : null;
  const invBefore = snapshotInventory(bot);

  const completed = [];
  const failed = [];
  for (let i = 0; i < skill.steps.length; i++) {
    if (Date.now() - started > skillTimeout) {
      return finish(false, `Skill timed out after ${skillTimeout}ms`, completed, failed, started, bot, skill, healthBefore, foodBefore, invBefore);
    }
    if (typeof options.shouldAbort === 'function') {
      let interrupt = null;
      try {
        interrupt = options.shouldAbort();
      } catch {
        interrupt = null;
      }
      if (interrupt) {
        return {
          ...finish(false, `Aborted at step ${i}: ${interrupt.type} — ${interrupt.reason || ''}`, completed, failed, started, bot, skill, healthBefore, foodBefore, invBefore),
          aborted: true,
          interrupt,
        };
      }
    }
    const step = skill.steps[i];
    const sub = substituteArgs(step.args, skill.parameters || [], args || {});
    if (!sub.ok) {
      failed.push({ index: i, primitive: step.primitive, error: sub.error });
      return finish(false, sub.error, completed, failed, started, bot, skill, healthBefore, foodBefore, invBefore, i);
    }
    let result;
    try {
      result = await executePrimitive(bot, { primitive: step.primitive, args: sub.value }, { timeoutMs: stepTimeout });
    } catch (err) {
      result = { ok: false, primitive: step.primitive, error: err?.message || 'Primitive crashed' };
    }
    if (result && result.ok) {
      completed.push({ index: i, primitive: step.primitive, result: summarizeResult(result) });
    } else {
      failed.push({ index: i, primitive: step.primitive, error: (result && result.error) || 'Step failed', result: summarizeResult(result) });
      return finish(false, (result && result.error) || `Step ${i} (${step.primitive}) failed`, completed, failed, started, bot, skill, healthBefore, foodBefore, invBefore, i);
    }
  }
  return finish(true, null, completed, failed, started, bot, skill, healthBefore, foodBefore, invBefore);
}

function summarizeResult(result) {
  if (!result || typeof result !== 'object') return null;
  const out = { ok: !!result.ok, primitive: result.primitive || null };
  for (const k of ['error', 'block', 'tool', 'dropObtained', 'weapon', 'food', 'position', 'timedOut']) {
    if (result[k] !== undefined) out[k] = result[k];
  }
  return out;
}

function finish(ok, error, completed, failed, started, bot, skill, healthBefore, foodBefore, invBefore, failedStep = null) {
  const healthAfter = typeof bot.health === 'number' ? bot.health : null;
  const foodAfter = typeof bot.food === 'number' ? bot.food : null;
  const invAfter = snapshotInventory(bot);
  return {
    ok,
    skillId: skill.id,
    skillName: skill.name,
    error,
    completedSteps: completed.length,
    totalSteps: skill.steps.length,
    failedStep,
    stepsCompleted: completed,
    stepsFailed: failed,
    durationMs: Date.now() - started,
    healthChange: healthBefore !== null && healthAfter !== null ? Math.round((healthAfter - healthBefore) * 10) / 10 : null,
    foodChange: foodBefore !== null && foodAfter !== null ? foodAfter - foodBefore : null,
    inventoryDelta: inventoryDelta(invBefore, invAfter),
  };
}

module.exports = { executeSkill, substituteArgs };
