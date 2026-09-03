'use strict';

function timestamp() {
  return new Date().toISOString();
}

function formatArgs(args) {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

const logger = {
  info(...args) {
    console.log(`[${timestamp()}] INFO ${formatArgs(args)}`);
  },
  warn(...args) {
    console.warn(`[${timestamp()}] WARN ${formatArgs(args)}`);
  },
  error(...args) {
    console.error(`[${timestamp()}] ERROR ${formatArgs(args)}`);
  },
  debug(...args) {
    if (process.env.LOG_LEVEL === 'debug') {
      console.log(`[${timestamp()}] DEBUG ${formatArgs(args)}`);
    }
  },
};

module.exports = { logger };
