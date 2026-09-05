#!/usr/bin/env node
'use strict';

// Print the active world's instance identity (ensuring the sidecar when
// missing). Used by start-agent.sh and diagnostics. Never touches game data.
//
// Usage: node scripts/world-id.cjs [--world-dir DIR] [--seed N]
// Prints the world id (or nothing on failure; exit 0 always so launchers
// fall back to legacy behavior instead of refusing to start).

const path = require('path');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

try {
  const mod = require('../src/world/instance');
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const worldDir =
    process.env.WORLD_DIR ||
    arg('--world-dir', path.join(home, 'minecraft-lab', 'server', 'world'));
  const seed = process.env.WORLD_SEED || arg('--seed', null);
  const identity = mod.ensureWorldId(worldDir, { seed });
  if (identity && identity.id) console.log(identity.id);
} catch {
  // silent: callers treat empty output as "no namespace available"
}
