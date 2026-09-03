'use strict';

// DEPRECATED (retained for backward compatibility): minimal in-memory episode
// buffer used by v1 benchmark code paths. Autonomous mode uses the JSON
// stores in semantic.js / episodic.js / procedural.js / world.js instead.
function createMemory(goal) {
  const history = [];
  return {
    goal,
    startedAt: new Date().toISOString(),
    recordStep(step, action, result) {
      history.push({ step, action, result });
      if (history.length > 200) history.shift();
    },
    getLastResult() {
      return history.length > 0 ? history[history.length - 1].result : null;
    },
    getHistory() {
      return history.slice();
    },
    summarize() {
      return {
        goal,
        startedAt: this.startedAt,
        steps: history.length,
        lastResult: this.getLastResult(),
      };
    },
  };
}

module.exports = { createMemory };
