'use strict';

// World memory: named locations and discoveries (home, mine, diamond vein...).
// { name, position:{x,y,z}, dimension, metadata, createdAt, updatedAt }

const { loadArray, saveArray, nowIso } = require('./store');
const { validId, namespaceFile } = require('../world/instance');

const LEGACY_FILE = 'world';

// World-coordinate memory is namespaced by world-instance ID so snapshots
// and fresh regens (even from the same seed) never share locations.
// AI_WORLD_ID comes from the launcher (start-agent.sh ensures the sidecar).
// Unset/invalid -> legacy shared file (backward compatible, documented).
// The legacy file is NEVER auto-imported into a namespace.
function activeFile() {
  try {
    const id = process.env.AI_WORLD_ID;
    if (id && validId(id)) return namespaceFile(id);
  } catch {
    // ignore
  }
  return LEGACY_FILE;
}

function namespace() {
  try {
    const id = process.env.AI_WORLD_ID;
    if (id && validId(id)) return { id, file: namespaceFile(id), legacy: false };
  } catch {
    // ignore
  }
  return { id: null, file: LEGACY_FILE, legacy: true };
}

function maxCount() {
  const v = parseInt(process.env.MAX_WORLD_MEMORIES || '500', 10);
  return Number.isFinite(v) && v > 0 ? Math.min(v, 5000) : 500;
}

function validPos(pos) {
  return !!pos && Number.isFinite(Number(pos.x)) && Number.isFinite(Number(pos.y)) && Number.isFinite(Number(pos.z));
}

function list() {
  return loadArray(activeFile());
}

function listAsMap() {
  const out = {};
  for (const e of list()) {
    if (e && typeof e.name === 'string') out[e.name] = e;
  }
  return out;
}

function get(name) {
  return list().find((e) => e && e.name === name) || null;
}

function remember(name, pos, metadata = {}, dimension = 'overworld') {
  if (typeof name !== 'string' || !name.trim() || name.length > 80 || !/^[A-Za-z0-9_-]+$/.test(name.trim())) {
    return { ok: false, error: 'name must match [A-Za-z0-9_-] (max 80 chars)' };
  }
  if (!validPos(pos)) return { ok: false, error: 'pos must have numeric x/y/z' };
  let safeMeta = {};
  try {
    safeMeta = JSON.parse(JSON.stringify(metadata || {}));
  } catch {
    safeMeta = {};
  }
  const items = loadArray(activeFile());
  const now = nowIso();
  const clean = name.trim();
  let entry = items.find((e) => e.name === clean);
  if (entry) {
    entry.position = { x: Number(pos.x), y: Number(pos.y), z: Number(pos.z) };
    entry.metadata = safeMeta;
    if (dimension) entry.dimension = String(dimension).slice(0, 40);
    entry.updatedAt = now;
  } else {
    entry = {
      name: clean,
      type: 'world',
      position: { x: Number(pos.x), y: Number(pos.y), z: Number(pos.z) },
      dimension: String(dimension || 'overworld').slice(0, 40),
      metadata: safeMeta,
      createdAt: now,
      updatedAt: now,
    };
    items.push(entry);
  }
  while (items.length > maxCount()) items.shift();
  saveArray(activeFile(), items);
  return { ok: true, entry };
}

function forget(name) {
  const items = loadArray(activeFile()).filter((e) => e.name !== name);
  saveArray(activeFile(), items);
  return { ok: true };
}

module.exports = { list, listAsMap, get, remember, forget, namespace, activeFile };
