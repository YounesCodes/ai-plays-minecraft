'use strict';

// Compact executed-action history + deterministic stagnation detection for
// autonomous-v2 cognition. Framework replay is gone (each completed action
// is followed by fresh cognition), so genuine MODEL repetition is now
// visible here instead of being manufactured by the loop.
//
// Stagnation is progress-aware, never repetition-alone: the same acquisition
// repeated with real inventory gains is healthy grinding, not a loop.

const MAX_ENTRIES = 10;
// Displacement below this counts as "essentially unchanged".
const MOVE_EPS = 1.5;
// Trailing identical actions without progress needed to flag stagnation.
const STAGNATION_COUNT = 3;

function stableArgs(args) {
  const a = args && typeof args === 'object' ? args : {};
  const keys = Object.keys(a).sort();
  const out = {};
  for (const k of keys) out[k] = a[k];
  try {
    return JSON.stringify(out);
  } catch {
    return '{}';
  }
}

function signature(nextStep) {
  if (!nextStep || typeof nextStep !== 'object') return 'unknown:?';
  const type = nextStep.type === 'skill' ? 'skill' : 'primitive';
  const name = typeof nextStep.name === 'string' ? nextStep.name : '?';
  return `${type}:${name}:${stableArgs(nextStep.args)}`;
}

function dist3(a, b) {
  if (!a || !b) return null;
  try {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    return Number.isFinite(d) ? d : null;
  } catch {
    return null;
  }
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function createActionHistory({ max = MAX_ENTRIES } = {}) {
  const entries = [];
  return {
    record({ step = null, nextStep = null, result = null, posBefore = null, posAfter = null, invBefore = null, invAfter = null } = {}) {
      const sig = signature(nextStep);
      const moved = (dist3(posBefore, posAfter) ?? 0) > MOVE_EPS;
      const gained = num(invAfter) > num(invBefore);
      const acted = !!(
        result &&
        result.ok === true &&
        (num(result.broken) > 0 ||
          num(result.collected) > 0 ||
          result.dropCollected === true ||
          num(result.distanceMoved) > 4 ||
          result.goalCompleted === true)
      );
      const entry = {
        step,
        action: sig,
        ok: result ? result.ok !== false : null,
        progress: moved || gained || acted,
        moved,
        invDelta: num(invAfter) - num(invBefore),
      };
      entries.push(entry);
      while (entries.length > max) entries.shift();
      return { ...entry };
    },
    // Compact summary for planner input: last few actions only.
    summary(last = 6) {
      return entries.slice(-last).map((e) => ({
        step: e.step,
        action: e.action,
        ok: e.ok,
        progress: e.progress,
      }));
    },
    // Trailing run of the identical signature.
    trailingRun() {
      if (entries.length === 0) return { signature: null, count: 0, entries: [] };
      const sig = entries[entries.length - 1].action;
      const run = [];
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i].action !== sig) break;
        run.unshift(entries[i]);
      }
      return { signature: sig, count: run.length, entries: run };
    },
    size() {
      return entries.length;
    },
    // Progress-aware stagnation: same action STAGNATION_COUNT+ times with no
    // meaningful state delta in any of them. General signals only
    // (displacement, inventory, acted gains) — no goal-specific hacks.
    detectStagnation() {
      const run = this.trailingRun();
      if (!run.signature || run.count < STAGNATION_COUNT) return { detected: false };
      const anyProgress = run.entries.some((e) => e.progress === true);
      if (anyProgress) return { detected: false };
      return {
        detected: true,
        repeatedAction: run.signature,
        count: run.count,
        reason: 'same action produced no meaningful progress',
      };
    },
  };
}

module.exports = { createActionHistory, signature, MOVE_EPS, STAGNATION_COUNT, MAX_ENTRIES };
