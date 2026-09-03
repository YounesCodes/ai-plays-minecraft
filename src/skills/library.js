'use strict';

// Skill library: JSON persistence for declarative skills with scoring fields.
// Runtime skill files live under data/ (git-ignored); seed skills can be
// provided by callers.

const { loadArray, saveArray, nowIso } = require('../memory/store');
const { validateSkill } = require('../safety/skillValidator');

const FILE = 'skills';

function maxSkills() {
  const v = parseInt(process.env.MAX_SKILLS || '200', 10);
  return Number.isFinite(v) && v > 0 ? Math.min(v, 1000) : 200;
}

function list() {
  return loadArray(FILE);
}

function get(idOrName) {
  const items = loadArray(FILE);
  return items.find((s) => s.id === idOrName || s.name === idOrName) || null;
}

function put(skill) {
  const check = validateSkill(skill);
  if (!check.ok) return check;
  const items = loadArray(FILE);
  const now = nowIso();
  const existing = items.find((s) => s.id === skill.id);
  if (existing) {
    const prevSuccess = existing.successCount || 0;
    const prevFailure = existing.failureCount || 0;
    Object.assign(existing, {
      name: skill.name,
      description: skill.description,
      parameters: [...skill.parameters],
      steps: skill.steps.map((s) => ({ primitive: s.primitive, args: { ...s.args } })),
      updatedAt: now,
      version: (existing.version || 1) + 1,
    });
    existing.successCount = prevSuccess;
    existing.failureCount = prevFailure;
    if (existing.score === undefined) existing.score = scoreOf(existing);
    saveArray(FILE, items);
    return { ok: true, id: existing.id, updated: true };
  }
  const entry = {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    parameters: [...skill.parameters],
    steps: skill.steps.map((s) => ({ primitive: s.primitive, args: { ...s.args } })),
    createdAt: skill.createdAt || now,
    updatedAt: now,
    successCount: 0,
    failureCount: 0,
    lastUsedAt: null,
    score: 0.5,
    version: 1,
  };
  items.push(entry);
  while (items.length > maxSkills()) {
    // Evict lowest score.
    let idx = 0;
    let best = Infinity;
    for (let i = 0; i < items.length; i++) {
      const sc = scoreOf(items[i]);
      if (sc < best) { best = sc; idx = i; }
    }
    items.splice(idx, 1);
  }
  saveArray(FILE, items);
  return { ok: true, id: entry.id };
}

function scoreOf(skill) {
  const s = Number(skill.successCount) || 0;
  const f = Number(skill.failureCount) || 0;
  const total = s + f;
  if (total === 0) return 0.5;
  return s / total;
}

function recordUse(id, ok) {
  const items = loadArray(FILE);
  const entry = items.find((s) => s.id === id);
  if (!entry) return null;
  if (ok) entry.successCount = (entry.successCount || 0) + 1;
  else entry.failureCount = (entry.failureCount || 0) + 1;
  entry.lastUsedAt = nowIso();
  entry.score = scoreOf(entry);
  saveArray(FILE, items);
  return entry;
}

function remove(id) {
  const items = loadArray(FILE).filter((s) => s.id !== id);
  saveArray(FILE, items);
  return { ok: true };
}

module.exports = { list, get, put, recordUse, remove, scoreOf };
