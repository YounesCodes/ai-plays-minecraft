'use strict';

// In-memory counters + lightweight gauges. No persistence, no database.
// Telemetry snapshots feed the future stream overlay.

const counters = {
  steps: 0,
  deaths: 0,
  logsCollected: 0,
  llmCalls: 0,
  llmErrors: 0,
  actionErrors: 0,
  primitivesExecuted: 0,
  primitiveErrors: 0,
  skillsExecuted: 0,
  skillFailures: 0,
  skillsGenerated: 0,
  reflections: 0,
  memoriesWritten: 0,
  goalChanges: 0,
  interrupts: 0,
};

function inc(name, by = 1) {
  if (!(name in counters)) counters[name] = 0;
  counters[name] += by;
  return counters[name];
}

function get(name) {
  return counters[name] ?? 0;
}

function snapshot() {
  return { ...counters };
}

function reset() {
  for (const key of Object.keys(counters)) counters[key] = 0;
}

module.exports = { inc, get, snapshot, reset };
