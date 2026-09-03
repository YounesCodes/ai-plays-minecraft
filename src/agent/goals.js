'use strict';

// Goal manager: primary directive + current goal + subgoals + suspension.

const { nowIso } = require('../memory/store');

const DEFAULT_DIRECTIVE = 'Survive and progress through Minecraft autonomously. Maintain health and food, explore, acquire resources, improve equipment, establish useful shelter and storage, learn from experience, and pursue increasingly advanced Minecraft progression while avoiding unnecessary death.';

function createGoalManager(options = {}) {
  const primaryDirective = options.directive || process.env.AGENT_DIRECTIVE || DEFAULT_DIRECTIVE;
  let currentGoal = options.initialGoal
    ? { description: options.initialGoal, priority: 50, reason: 'Initial goal', createdAt: nowIso(), status: 'active' }
    : null;
  let subgoals = [];
  let suspendedGoal = null;
  let history = [];

  function getState() {
    return {
      primaryDirective,
      currentGoal: currentGoal ? { ...currentGoal } : null,
      subgoals: [...subgoals],
      suspendedGoal: suspendedGoal ? { ...suspendedGoal } : null,
    };
  }

  function setGoal(description, opts = {}) {
    if (typeof description !== 'string' || !description.trim() || description.length > 300) {
      return { ok: false, error: 'Goal description must be a non-empty string (max 300 chars)' };
    }
    if (currentGoal && currentGoal.status === 'active') {
      history.push({ ...currentGoal, status: 'replaced', endedAt: nowIso() });
    }
    currentGoal = {
      description: description.trim(),
      priority: Number.isFinite(Number(opts.priority)) ? Math.max(0, Math.min(100, Number(opts.priority))) : 50,
      reason: String(opts.reason || '').slice(0, 300),
      createdAt: nowIso(),
      status: 'active',
    };
    if (Array.isArray(opts.subgoals)) {
      subgoals = opts.subgoals.filter((s) => typeof s === 'string').map((s) => s.slice(0, 200)).slice(0, 8);
    }
    if (history.length > 50) history = history.slice(-50);
    return { ok: true, goal: { ...currentGoal } };
  }

  function completeGoal(note = '') {
    if (!currentGoal) return { ok: false, error: 'No current goal' };
    history.push({ ...currentGoal, status: 'completed', endedAt: nowIso(), note: String(note).slice(0, 300) });
    const done = { ...currentGoal, status: 'completed' };
    currentGoal = null;
    subgoals = [];
    // Resume suspended goal if present.
    if (suspendedGoal) {
      currentGoal = { ...suspendedGoal, status: 'active', resumedAt: nowIso() };
      suspendedGoal = null;
    }
    return { ok: true, completed: done, current: currentGoal ? { ...currentGoal } : null };
  }

  function suspendFor(emergencyDescription, opts = {}) {
    if (!currentGoal) {
      return setGoal(emergencyDescription, opts);
    }
    suspendedGoal = { ...currentGoal, status: 'suspended', suspendedAt: nowIso() };
    currentGoal = {
      description: emergencyDescription,
      priority: Number.isFinite(Number(opts.priority)) ? Math.max(0, Math.min(100, Number(opts.priority))) : 90,
      reason: String(opts.reason || 'Interrupt preempted previous goal').slice(0, 300),
      createdAt: nowIso(),
      status: 'active',
    };
    return { ok: true, goal: { ...currentGoal }, suspended: { ...suspendedGoal } };
  }

  function failGoal(error = '') {
    if (!currentGoal) return { ok: false, error: 'No current goal' };
    history.push({ ...currentGoal, status: 'failed', endedAt: nowIso(), note: String(error).slice(0, 300) });
    currentGoal.failCount = (currentGoal.failCount || 0) + 1;
    return { ok: true, goal: { ...currentGoal } };
  }

  function getHistory() {
    return history.slice();
  }

  return { getState, setGoal, completeGoal, suspendFor, failGoal, getHistory, primaryDirective };
}

module.exports = { createGoalManager, DEFAULT_DIRECTIVE };
