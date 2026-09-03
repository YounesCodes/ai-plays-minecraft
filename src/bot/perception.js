'use strict';

// Thin perception facade: builds bounded observations with a shared cache so
// repeated cognition ticks don't hammer block scanning. Cache object is owned
// by the caller (agent loop) and passed into observe().

const { observe } = require('./observations');

function createPerceptionCache() {
  return { interestingBlocks: null };
}

function perceive(bot, options = {}) {
  const cache = options.cache || createPerceptionCache();
  const perception = observe(bot, { ...options, cache });
  return { perception, cache };
}

module.exports = { createPerceptionCache, perceive };
