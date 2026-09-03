'use strict';

// JSON persistence helpers: tolerant loads (missing/malformed files -> empty),
// bounded arrays, atomic-ish writes (tmp + rename).

const fs = require('fs');
const path = require('path');

function dataDir() {
  return process.env.MEMORY_DIR || path.join(__dirname, '..', '..', 'data');
}

function fileFor(name) {
  return path.join(dataDir(), `${name}.json`);
}

function ensureDir() {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
  } catch {
    // ignore
  }
}

function loadArray(name) {
  const file = fileFor(name);
  try {
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.items)) return parsed.items;
    return [];
  } catch {
    // Corrupted file: back it up once and start empty rather than crash.
    try {
      const backup = `${file}.corrupt.${Date.now()}.bak`;
      fs.copyFileSync(file, backup);
    } catch {
      // ignore
    }
    return [];
  }
}

function saveArray(name, items) {
  ensureDir();
  const file = fileFor(name);
  const tmp = `${file}.tmp.${process.pid}`;
  const payload = JSON.stringify(items, null, 2);
  try {
    fs.writeFileSync(tmp, payload, 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

function loadObject(name) {
  const file = fileFor(name);
  try {
    if (!fs.existsSync(file)) return {};
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return {};
  } catch {
    try {
      const backup = `${file}.corrupt.${Date.now()}.bak`;
      fs.copyFileSync(file, backup);
    } catch {
      // ignore
    }
    return {};
  }
}

function saveObject(name, obj) {
  ensureDir();
  const file = fileFor(name);
  const tmp = `${file}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}

module.exports = { dataDir, fileFor, loadArray, saveArray, loadObject, saveObject, nowIso, makeId };
