'use strict';

// Action dispatch.
// - Benchmark mode: legacy allowlist (observe/collect_logs/chat/wait/finish).
// - Autonomous mode: validated primitives + declarative skills via
//   src/primitives and src/skills/executor. The LLM never touches Mineflayer.

const { validateAction } = require('../safety/validator');
const { observe } = require('../bot/observations');
const { executePrimitive } = require('../primitives');
const { executeSkill } = require('../skills/executor');
const skillLibrary = require('../skills/library');
const { getLimits } = require('../safety/limits');
const { logger } = require('../telemetry/logger');
let collectLogsCache = null;
function getCollectLogs() {
  if (!collectLogsCache) {
    try {
      collectLogsCache = require('../skills/collectLogs').collectLogs;
    } catch {
      collectLogsCache = null;
    }
  }
  return collectLogsCache;
}

function countLogsInBot(bot) {
  try {
    const mod = require('../skills/collectLogs');
    if (mod && typeof mod.countLogs === 'function') return mod.countLogs(bot);
  } catch {
    // ignore; timeout path still reports the failure
  }
  return 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getActionDefinitions() {
  return [
    { name: 'observe' },
    { name: 'collect_logs' },
    { name: 'chat' },
    { name: 'wait' },
    { name: 'finish' },
  ];
}

// Legacy benchmark dispatch (preserved for regression testing).
async function executeAction(bot, action) {
  const check = validateAction(action);
  if (!check.ok) {
    return { ok: false, error: check.error };
  }
  const a = check.value;

  switch (a.action) {
    case 'observe':
      return { ok: true, observation: observe(bot) };
    case 'collect_logs': {
      const collectLogs = getCollectLogs();
      if (!collectLogs) return { ok: false, error: 'collectLogs skill unavailable' };
      // Timebox: an unreachable block must fail the step, never hang the loop.
      // Scales with requested work, capped at the skill timeout.
      const limits = getLimits();
      const timeoutMs = Math.min(
        limits.skillTimeoutMs,
        Math.max(limits.primitiveTimeoutMs, a.amount * limits.primitiveTimeoutMs)
      );
      let timer = null;
      const pending = collectLogs(bot, a.amount);
      // The race loser may settle later; mark it handled so a late rejection
      // can never crash the process as unhandled.
      pending.catch(() => {});
      try {
        const res = await Promise.race([
          pending,
          new Promise((resolve) => {
            timer = setTimeout(
              () => resolve({ ok: false, collected: countLogsInBot(bot), timedOut: true, error: `collect_logs timed out after ${timeoutMs}ms` }),
              timeoutMs
            );
          }),
        ]);
        if (res && res.timedOut) {
          logger.warn(`collect_logs timed out after ${timeoutMs}ms; stopping bot activity so the next step starts clean.`);
        }
        return res;
      } finally {
        if (timer) clearTimeout(timer);
        // Untangle the bot so the next step starts from a clean slate even
        // if the underlying collect is still wedged in the background.
        try { if (bot.collectBlock && typeof bot.collectBlock.stop === 'function') bot.collectBlock.stop(); } catch { /* ignore */ }
        try { if (bot.pathfinder && typeof bot.pathfinder.stop === 'function') bot.pathfinder.stop(); } catch { /* ignore */ }
        try { if (typeof bot.clearControlStates === 'function') bot.clearControlStates(); } catch { /* ignore */ }
      }
    }
    case 'chat': {
      const res = await executePrimitive(bot, { primitive: 'chat', args: { message: a.message } });
      if (!res.ok) return res;
      return { ok: true, sent: a.message };
    }
    case 'wait': {
      await sleep(a.seconds * 1000);
      return { ok: true, waited: a.seconds };
    }
    case 'finish':
      return { ok: true, done: true, reason: a.reason };
    default:
      return { ok: false, error: `Unsupported action: ${a.action}` };
  }
}

// Autonomous single-step dispatch: { type:'primitive', name, args } or
// { type:'skill', name, args }. Resolves skills from the library.
async function executeNextStep(bot, nextStep, ctx = {}) {
  if (!nextStep || typeof nextStep !== 'object') {
    return { ok: false, error: 'nextStep must be an object' };
  }
  if (nextStep.type === 'primitive') {
    return executePrimitive(bot, { primitive: nextStep.name, args: nextStep.args || {} }, ctx);
  }
  if (nextStep.type === 'skill') {
    const skill = skillLibrary.get(nextStep.name);
    if (!skill) {
      return { ok: false, error: `Unknown skill: ${nextStep.name}` };
    }
    const limits = getLimits();
    return executeSkill(bot, skill, nextStep.args || {}, {
      timeoutMs: limits.skillTimeoutMs,
      stepTimeoutMs: limits.primitiveTimeoutMs,
      shouldAbort: ctx.shouldAbort,
    });
  }
  return { ok: false, error: `Unknown nextStep type: ${nextStep.type}` };
}

module.exports = { getActionDefinitions, executeAction, executeNextStep };
