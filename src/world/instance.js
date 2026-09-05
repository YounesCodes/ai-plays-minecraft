'use strict';

// World-instance identity: which ACTUAL world directory is active, not just
// which seed generated it. Fresh regens from the same fixed seed are
// DIFFERENT test instances and must never share coordinate memory.
//
// Sidecar lives inside the active world dir:
//   <server>/world/.ai-world-id  ->  {"id","seed","createdAt"}
// Snapshots carry it automatically (it is inside the world directory).
// `prepare fresh` always mints a new ID, even for a repeated seed.
// `restore` brings the snapshot's own ID back.
// The seed is metadata only — never the namespace key.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ID_PATTERN = /^world_[0-9a-f]{16}$/;
const SIDECAR = '.ai-world-id';

function validId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

function generateId() {
  try {
    return `world_${crypto.randomBytes(8).toString('hex')}`;
  } catch {
    return `world_${Date.now().toString(16)}${Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0')}`.slice(0, 22);
  }
}

function sidecarPath(serverWorldDir) {
  return path.join(serverWorldDir, SIDECAR);
}

function readWorldId(serverWorldDir) {
  try {
    if (!serverWorldDir || typeof serverWorldDir !== 'string') return null;
    const raw = fs.readFileSync(sidecarPath(serverWorldDir), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !validId(parsed.id)) return null;
    return {
      id: parsed.id,
      seed: typeof parsed.seed === 'string' || typeof parsed.seed === 'number' ? String(parsed.seed) : null,
      createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : null,
    };
  } catch {
    return null;
  }
}

// Assign an identity to a world that lacks one (existing/legacy worlds).
// Never regenerates: returns the stored identity when present. Writes only
// the tiny sidecar — game data untouched. Safe on a running server (Paper
// ignores unknown dotfiles).
function ensureWorldId(serverWorldDir, { seed = null } = {}) {
  const existing = readWorldId(serverWorldDir);
  if (existing) return existing;
  const identity = {
    id: generateId(),
    seed: seed === null || seed === undefined ? null : String(seed),
    createdAt: new Date().toISOString(),
  };
  try {
    fs.mkdirSync(serverWorldDir, { recursive: true });
    const tmp = `${sidecarPath(serverWorldDir)}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(identity, null, 2));
    fs.renameSync(tmp, sidecarPath(serverWorldDir));
  } catch {
    // If the sidecar cannot be written, return the identity anyway so the
    // caller can proceed in-memory (legacy file behavior downstream).
  }
  return identity;
}

// Namespace file stem for world-coordinate memory. Strictly validated —
// a malicious/invalid ID can never escape into a path.
function namespaceFile(id) {
  if (!validId(id)) return null;
  return `world.${id}`;
}

module.exports = { validId, generateId, readWorldId, ensureWorldId, namespaceFile, ID_PATTERN, SIDECAR };
