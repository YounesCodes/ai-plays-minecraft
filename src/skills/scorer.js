'use strict';

// Skill scoring: thin wrapper that keeps the skill library and procedural
// memory in sync after each execution outcome.

const library = require('./library');
const procedural = require('../memory/procedural');

function scoreSkillOutcome(skillId, outcome) {
  const ok = !!outcome?.ok;
  const entry = library.recordUse(skillId, ok);
  try {
    if (process.env.MEMORY_ENABLED !== 'false' && process.env.MEMORY_ENABLED !== '0') {
      procedural.recordOutcome(skillId, ok);
    }
  } catch {
    // memory failures must never break scoring
  }
  return {
    skillId,
    ok,
    successCount: entry?.successCount ?? (ok ? 1 : 0),
    failureCount: entry?.failureCount ?? (ok ? 0 : 1),
    score: entry?.score ?? (ok ? 1 : 0),
  };
}

// Rank candidate skills for a goal/context: prefer higher score, penalize
// repeated recent failures.
function rankSkills(skills, options = {}) {
  const maxFailures = options.maxFailures ?? 5;
  const arr = (skills || []).map((s) => {
    const failures = Number(s.failureCount) || 0;
    const base = s.score !== undefined ? Number(s.score) : 0.5;
    const penalty = failures >= maxFailures ? 0.5 : failures * 0.05;
    return { skill: s, rank: base - penalty };
  });
  arr.sort((a, b) => b.rank - a.rank);
  return arr.map((r) => r.skill);
}

module.exports = { scoreSkillOutcome, rankSkills };
