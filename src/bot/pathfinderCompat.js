'use strict';

// Compatibility: Minecraft 1.21.x server-side collision sweep bug.
//
// Upstream: PrismarineJS/mineflayer-pathfinder#366 — on servers newer than
// 1.21.8 (including our pinned 1.21.11), bots walk into one-block obstacles
// instead of stepping/jumping over them. Proposed fix PR #364: slightly
// expand the client physics hitbox so the client stops a micro-gap short of
// perfect wall alignment, bypassing the float edge case that makes the
// server reject the movement.
//
// This module applies ONLY that 9-line workaround, and only when:
// - the bot version is in the known-affected 1.21.x range (currently 1.21.9
//   through 1.21.11; we pin 1.21.11),
// - bot.physics exists with exactly the expected stock values
//   (halfWidth 0.3, height 1.8), so we never stack the bump twice.
//
// No node_modules modifications, no dependency fork, no Pathfinder
// monkey-patching. If upstream fixes it, delete this file and its call
// sites (createBot + locomotion bench runner).

const { logger } = require('../telemetry/logger');

const EXPECTED_HALF_WIDTH = 0.3;
const EXPECTED_HEIGHT = 1.8;
const PATCHED_HALF_WIDTH = 0.30001;
const PATCHED_HEIGHT = 1.80001;

function supported(version) {
  if (typeof version !== 'string') return false;
  const m = version.match(/^1\.21\.(\d+)/);
  if (!m) return false;
  const minor = parseInt(m[1], 10);
  return Number.isFinite(minor) && minor >= 9 && minor <= 11;
}

function alreadyApplied(bot) {
  try {
    return (
      bot?.physics?.playerHalfWidth === PATCHED_HALF_WIDTH &&
      bot?.physics?.playerHeight === PATCHED_HEIGHT
    );
  } catch {
    return false;
  }
}

function applyPathfinderCompat(bot, version) {
  try {
    if (!bot || !bot.physics) {
      logger.debug('pathfinder-compat: skipped (no bot.physics yet)');
      return false;
    }
    if (alreadyApplied(bot)) return true;
    if (!supported(version)) {
      logger.debug(`pathfinder-compat: skipped (version ${version} out of 1.21.9-1.21.11 range)`);
      return false;
    }
    if (bot.physics.playerHalfWidth !== EXPECTED_HALF_WIDTH || bot.physics.playerHeight !== EXPECTED_HEIGHT) {
      logger.debug('pathfinder-compat: skipped (unexpected stock physics values)');
      return false;
    }
    bot.physics.playerHalfWidth = PATCHED_HALF_WIDTH;
    bot.physics.playerHeight = PATCHED_HEIGHT;
    logger.info(
      `pathfinder-compat: applied 1.21.x collision workaround for ${version} (see mineflayer-pathfinder#366/#364)`
    );
    return true;
  } catch (err) {
    logger.debug(`pathfinder-compat: skipped (${err?.message || err})`);
    return false;
  }
}

module.exports = {
  applyPathfinderCompat,
  supported,
  alreadyApplied,
  EXPECTED_HALF_WIDTH,
  EXPECTED_HEIGHT,
  PATCHED_HALF_WIDTH,
  PATCHED_HEIGHT,
};
