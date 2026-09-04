'use strict';

const { createBot } = require('./bot/createBot');
const { installEvents } = require('./bot/events');
const { runAgentLoop } = require('./agent/loop');
const { getLimits } = require('./safety/limits');
const { logger } = require('./telemetry/logger');

async function main() {
  const bot = createBot();
  installEvents(bot);
  // True once WE initiate a disconnect. Clean exits must not look like
  // crashes to the connection-loss guard below.
  let quitting = false;

  const limits = getLimits();
  const mode = (process.env.AGENT_MODE || 'autonomous').toLowerCase() === 'benchmark' ? 'benchmark' : 'autonomous';
  const goal = process.env.AGENT_GOAL || 'Collect 8 logs without dying.';

  logger.info(`Starting agent in ${mode} mode.`);

  bot.once('spawn', () => {
    runAgentLoop(bot, mode === 'benchmark' ? { mode, goal } : { mode })
      .then((summary) => {
        logger.info(`Agent loop ended: ${JSON.stringify(summary)}`);
        if (mode === 'benchmark') {
          quitting = true;
          try { bot.quit('benchmark complete'); } catch { /* ignore */ }
          setTimeout(() => process.exit(0), 500);
        }
        // Autonomous mode stays connected; loop only returns on budget end.
        if (mode === 'autonomous' && summary && summary.status === 'budget_exhausted') {
          quitting = true;
          try { bot.quit('step budget exhausted'); } catch { /* ignore */ }
          setTimeout(() => process.exit(0), 500);
        }
      })
      .catch((err) => {
        logger.error(`Agent loop crashed: ${err && err.message ? err.message : err}`);
        // A dead loop with a live process is invisible to systemd
        // Restart=on-failure; exit nonzero so the service restarts us.
        setTimeout(() => process.exit(1), 500);
      });
  });

  // Respawn safety: never start a duplicate loop; runAgentLoop guards via
  // bot.__agentLoopRunning, and respawn is handled inside the loop.
  // Connection-loss supervisor for 24/7 operation: Mineflayer does not
  // reconnect by itself, and an idle-but-alive process defeats systemd
  // Restart=on-failure. Exit nonzero so the service restarts us; restarts
  // are cheap (memory persists in data/, position in playerdata).
  bot.on('end', () => {
    if (mode === 'autonomous' && !quitting && bot.__agentLoopRunning) {
      logger.error('Minecraft connection ended while the autonomous loop was running; exiting for systemd restart.');
      setTimeout(() => process.exit(2), 500);
    }
  });

  bot.on('death', () => {
    logger.warn('Bot died; autonomous loop will handle respawn (no duplicate loop).');
  });

  const shutdown = () => {
    logger.info('Shutting down...');
    quitting = true;
    try {
      bot.quit('shutdown');
    } catch {
      // already disconnected
    }
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  void limits;
}

if (require.main === module) {
  main().catch((err) => {
    logger.error(`Startup failed: ${err && err.message ? err.message : err}`);
    process.exit(1);
  });
}

module.exports = { main };
