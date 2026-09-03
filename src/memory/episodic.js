'use strict';

// Episodic memory: important experiences with context + lesson.
// { id, type:'episodic', summary, context, lesson, createdAt }

const { loadArray, saveArray, nowIso, makeId } = require('./store');

const FILE = 'episodic';

function maxCount() {
  const v = parseInt(process.env.MAX_EPISODIC_MEMORIES || '500', 10);
  return Number.isFinite(v) && v > 0 ? Math.min(v, 5000) : 500;
}

function list() {
  return loadArray(FILE);
}

function add({ summary, context = {}, lesson = '' }) {
  if (typeof summary !== 'string' || !summary.trim() || summary.length > 500) {
    return { ok: false, error: 'summary must be a non-empty string (max 500 chars)' };
  }
  if (lesson && (typeof lesson !== 'string' || lesson.length > 500)) {
    return { ok: false, error: 'lesson must be a string (max 500 chars)' };
  }
  let safeContext = {};
  try {
    safeContext = JSON.parse(JSON.stringify(context || {}));
  } catch {
    safeContext = {};
  }
  const items = loadArray(FILE);
  const now = nowIso();
  const norm = String(summary).trim().toLowerCase();
  const recent = items.slice(-20);
  if (recent.some((m) => String(m.summary || '').trim().toLowerCase() === norm)) {
    return { ok: true, deduplicated: true };
  }
  const entry = {
    id: makeId('epi'),
    type: 'episodic',
    summary: summary.trim(),
    context: safeContext,
    lesson: String(lesson || '').trim(),
    createdAt: now,
  };
  items.push(entry);
  while (items.length > maxCount()) items.shift();
  saveArray(FILE, items);
  return { ok: true, id: entry.id };
}

module.exports = { list, add };
