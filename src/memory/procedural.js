'use strict';

// Procedural memory: learned strategy records keyed by skill id.
// { skillId, description, successCount, failureCount, updatedAt }

const { loadArray, saveArray, nowIso } = require('./store');

const FILE = 'procedural';

function list() {
  return loadArray(FILE);
}

function get(skillId) {
  return list().find((m) => m.skillId === skillId) || null;
}

function upsert({ skillId, description = '' }) {
  if (typeof skillId !== 'string' || !skillId.trim() || skillId.length > 120) {
    return { ok: false, error: 'skillId must be a non-empty string' };
  }
  const items = loadArray(FILE);
  let entry = items.find((m) => m.skillId === skillId);
  if (!entry) {
    entry = {
      skillId,
      type: 'procedural',
      description: String(description || '').slice(0, 500),
      successCount: 0,
      failureCount: 0,
      updatedAt: nowIso(),
    };
    items.push(entry);
  } else if (description) {
    entry.description = String(description).slice(0, 500);
    entry.updatedAt = nowIso();
  }
  const max = parseInt(process.env.MAX_SKILLS || '200', 10) || 200;
  while (items.length > max) items.shift();
  saveArray(FILE, items);
  return { ok: true, entry };
}

function recordOutcome(skillId, ok) {
  const items = loadArray(FILE);
  let entry = items.find((m) => m.skillId === skillId);
  if (!entry) {
    entry = { skillId, type: 'procedural', description: '', successCount: 0, failureCount: 0, updatedAt: nowIso() };
    items.push(entry);
  }
  if (ok) entry.successCount = (entry.successCount || 0) + 1;
  else entry.failureCount = (entry.failureCount || 0) + 1;
  entry.updatedAt = nowIso();
  saveArray(FILE, items);
  return entry;
}

module.exports = { list, get, upsert, recordOutcome };
