'use strict';

// DEPRECATED (retained for backward compatibility): in-memory location
// bookmarks. Autonomous mode uses world.js (JSON-persisted) instead.
function createLocations() {
  const map = new Map();
  return {
    remember(name, pos) {
      if (typeof name !== 'string' || !name) throw new Error('Invalid location name');
      map.set(name, { x: pos.x, y: pos.y, z: pos.z });
    },
    get(name) {
      return map.get(name) || null;
    },
    list() {
      return Object.fromEntries(map.entries());
    },
    forget(name) {
      map.delete(name);
    },
    clear() {
      map.clear();
    },
    toJSON() {
      return Object.fromEntries(map.entries());
    },
    fromJSON(obj) {
      map.clear();
      for (const [k, v] of Object.entries(obj || {})) map.set(k, v);
    },
  };
}

module.exports = { createLocations };
