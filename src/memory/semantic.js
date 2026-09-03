'use strict';

// Semantic memory: general Minecraft facts the agent believes.
// { id, type:'semantic', subject, content, confidence, source, createdAt, updatedAt }

const { loadArray, saveArray, nowIso, makeId } = require('./store');

const FILE = 'semantic';

function maxCount() {
  const v = parseInt(process.env.MAX_SEMANTIC_MEMORIES || '500', 10);
  return Number.isFinite(v) && v > 0 ? Math.min(v, 5000) : 500;
}

function normalize(s) {
  return String(s || '').trim().toLowerCase();
}

function list() {
  return loadArray(FILE);
}

function findBySubject(subject) {
  const n = normalize(subject);
  return list().filter((m) => normalize(m.subject) === n);
}

function add({ subject, content, confidence = 0.6, source = 'experience' }) {
  if (typeof subject !== 'string' || !subject.trim() || subject.length > 120) {
    return { ok: false, error: 'subject must be a non-empty string (max 120 chars)' };
  }
  if (typeof content !== 'string' || !content.trim() || content.length > 500) {
    return { ok: false, error: 'content must be a non-empty string (max 500 chars)' };
  }
  let conf = Number(confidence);
  if (!Number.isFinite(conf)) conf = 0.6;
  conf = Math.max(0, Math.min(1, conf));

  const items = loadArray(FILE);
  const now = nowIso();
  // Deduplication: same subject+content -> refresh confidence/timestamp.
  const key = `${normalize(subject)}::${normalize(content)}`;
  const existing = items.find((m) => `${normalize(m.subject)}::${normalize(m.content)}` === key);
  if (existing) {
    existing.confidence = Math.max(Number(existing.confidence) || 0, conf);
    existing.updatedAt = now;
    existing.source = source || existing.source;
    saveArray(FILE, items);
    return { ok: true, id: existing.id, deduplicated: true };
  }
  const entry = {
    id: makeId('sem'),
    type: 'semantic',
    subject: subject.trim(),
    content: content.trim(),
    confidence: conf,
    source: String(source || 'experience').slice(0, 40),
    createdAt: now,
    updatedAt: now,
  };
  items.push(entry);
  // Prune: keep highest-confidence + most-recent within bound.
  while (items.length > maxCount()) {
    let dropIdx = 0;
    let dropScore = Infinity;
    for (let i = 0; i < items.length; i++) {
      const m = items[i];
      const score = (Number(m.confidence) || 0) * 1000 + (Date.parse(m.updatedAt || m.createdAt || 0) || 0) / 1e12;
      if (score < dropScore) { dropScore = score; dropIdx = i; }
    }
    items.splice(dropIdx, 1);
  }
  saveArray(FILE, items);
  return { ok: true, id: entry.id };
}

module.exports = { list, findBySubject, add };
