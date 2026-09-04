'use strict';

const { logger } = require('../telemetry/logger');

// Install useful, low-noise event handlers. Does not restart the process;
// in-game respawn is handled by the server/bot itself, and the agent loop
// resumes cognition only once respawn is stable (health > 0).
function installEvents(bot) {
  bot.on('login', () => {
    logger.info(`Logged in as ${bot.username}`);
  });

  bot.on('spawn', () => {
    const p = bot.entity?.position;
    if (p) {
      logger.info(`Spawned at ${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}`);
    } else {
      logger.info('Spawned');
    }
  });

  bot.on('health', () => {
    // Only log meaningful health drops, not every tick.
    if (bot.health <= 10) {
      logger.warn(`Low health: ${bot.health} food=${bot.food}`);
    }
  });

  bot.on('death', () => {
    // Death counting + memory live in the agent loop (single authoritative
    // path with step/position context); here we only log so the overlay
    // metric is never double-counted.
    logger.warn('Bot died; agent loop handles respawn and records it (no duplicate loop).');
  });

  bot.on('kicked', (reason) => {
    let text = reason;
    try {
      text = typeof reason === 'string' ? reason : JSON.stringify(reason);
    } catch {
      text = String(reason);
    }
    logger.warn(`Kicked: ${text}`);
  });

  bot.on('error', (err) => {
    logger.error(`Bot error: ${err && err.message ? err.message : err}`);
  });

  bot.on('end', (reason) => {
    logger.warn(`Connection ended: ${reason || ''}`);
  });

  return bot;
}

module.exports = { installEvents };
