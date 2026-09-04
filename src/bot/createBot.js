'use strict';

const mineflayer = require('mineflayer');
const pathfinder = require('mineflayer-pathfinder');
const collectBlock = require('mineflayer-collectblock');
const { applyPathfinderCompat } = require('./pathfinderCompat');

function createBot() {
  const host = process.env.MC_HOST || '127.0.0.1';
  const port = parseInt(process.env.MC_PORT || '25565', 10);
  const username = process.env.MC_USERNAME || 'Agent01';
  const version = process.env.MC_VERSION || '1.21.11';

  const bot = mineflayer.createBot({
    host,
    port,
    username,
    version,
    auth: 'offline',
  });

  bot.loadPlugin(pathfinder.pathfinder);
  bot.loadPlugin(collectBlock.plugin);
  // 1.21.x collision workaround if applicable (no-op otherwise; re-applied
  // on spawn in case physics initializes at login).
  try {
    applyPathfinderCompat(bot, version);
  } catch {
    // ignore; spawn handler retries
  }

  bot.once('spawn', () => {
    try {
      applyPathfinderCompat(bot, version);
    } catch {
      // ignore
    }
    const { Movements } = pathfinder;
    const movements = new Movements(bot);
    // Conservative defaults: no risky 1x1 tower building for v1.
    movements.allow1by1towers = false;
    movements.canDig = true;
    movements.allowSprinting = true;
    movements.allowParkour = false;
    bot.pathfinder.setMovements(movements);
  });

  return bot;
}

module.exports = { createBot };
