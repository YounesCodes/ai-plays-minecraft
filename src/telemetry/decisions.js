'use strict';

// Decision/event stream: JSONL append-only log for future visualization
// (Twitch overlay). Respects LOG_LEVEL-style debug gating for payload size.

const fs = require('fs');
const path = require('path');

function logDir() {
  return process.env.LOG_DIR || path.join(__dirname, '..', '..', 'logs');
}

function logFile() {
  return path.join(logDir(), 'decisions.jsonl');
}

function ensureDir() {
  try {
    fs.mkdirSync(logDir(), { recursive: true });
  } catch {
    // ignore
  }
}

function sanitize(value, depth = 0) {
  if (depth > 4) return '[truncated]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    // Never log secrets.
    if (/api[_-]?key|bearer|token|secret|password/i.test(value.slice(0, 60))) return '[redacted]';
    return value.length > 2000 ? `${value.slice(0, 2000)}…[truncated]` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitize(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 40)) {
      if (/api[_-]?key|OPENROUTER|authorization|secret|password|token/i.test(k)) {
        out[k] = '[redacted]';
      } else {
        out[k] = sanitize(v, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

function record(type, data = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    type,
    ...sanitize(data),
  };
  try {
    ensureDir();
    fs.appendFileSync(logFile(), `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // Telemetry must never crash the agent.
  }
  return entry;
}

module.exports = { record, logFile };
