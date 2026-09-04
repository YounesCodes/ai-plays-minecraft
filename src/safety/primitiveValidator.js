'use strict';

// Canonical trusted-primitive schemas + validation. This is the security
// boundary: the LLM may only invoke names listed here with args that pass
// these schemas. No executable payloads, paths, URLs, or env access.

const NAME_PATTERN = /^[a-z0-9_]+$/;
const DANGEROUS_KEY_PATTERN = /^(code|command|cmd|exec|eval|script|javascript|js|shell|file|path|url|http|https?|env|process|require|import|function|constructor|prototype|__proto__|method|api|fetch|child|spawn|fork|cluster)$/i;

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// argSpec: { type: 'string'|'integer'|'number'|'boolean', required, min, max,
//            pattern, enum, maxLength, allowNull, const }
function checkValue(spec, value, argName) {
  if (value === null || value === undefined) {
    if (spec.allowNull && !spec.required) return { ok: true, value: null };
    return { ok: false, error: `${argName} is required` };
  }
  switch (spec.type) {
    case 'string': {
      if (typeof value !== 'string') return { ok: false, error: `${argName} must be a string` };
      if (spec.pattern && !spec.pattern.test(value)) return { ok: false, error: `${argName} has invalid format` };
      if (spec.enum && !spec.enum.includes(value)) return { ok: false, error: `${argName} must be one of: ${spec.enum.join(', ')}` };
      if (spec.const !== undefined && value !== spec.const) return { ok: false, error: `${argName} must be "${spec.const}"` };
      if (spec.maxLength && value.length > spec.maxLength) return { ok: false, error: `${argName} must be at most ${spec.maxLength} characters` };
      if (spec.minLength && value.trim().length < spec.minLength) return { ok: false, error: `${argName} must be non-empty` };
      return { ok: true, value: spec.trim === false ? value : value };
    }
    case 'integer': {
      if (!Number.isInteger(value)) return { ok: false, error: `${argName} must be an integer` };
      if (spec.min !== undefined && value < spec.min) return { ok: false, error: `${argName} must be >= ${spec.min}` };
      if (spec.max !== undefined && value > spec.max) return { ok: false, error: `${argName} must be <= ${spec.max}` };
      return { ok: true, value };
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, error: `${argName} must be a finite number` };
      if (spec.min !== undefined && value < spec.min) return { ok: false, error: `${argName} must be >= ${spec.min}` };
      if (spec.max !== undefined && value > spec.max) return { ok: false, error: `${argName} must be <= ${spec.max}` };
      return { ok: true, value };
    }
    case 'boolean': {
      if (typeof value !== 'boolean') return { ok: false, error: `${argName} must be a boolean` };
      return { ok: true, value };
    }
    default:
      return { ok: false, error: `Unknown schema type for ${argName}` };
  }
}

const ITEM_NAME = { type: 'string', required: true, pattern: NAME_PATTERN, maxLength: 64 };
const OPTIONAL_ITEM_NAME = { type: 'string', required: false, pattern: NAME_PATTERN, maxLength: 64 };

// Canonical schemas for every trusted primitive.
const PRIMITIVE_SCHEMAS = {
  move_near: {
    x: { type: 'number', required: true, min: -30000000, max: 30000000 },
    y: { type: 'number', required: true, min: -64, max: 320 },
    z: { type: 'number', required: true, min: -30000000, max: 30000000 },
    range: { type: 'number', required: false, min: 1, max: 8 },
  },
  move_near_entity: {
    entityId: { type: 'integer', required: true, min: 0, max: 100000000 },
    distance: { type: 'number', required: false, min: 1, max: 16 },
  },
  move_away_from_entity: {
    entityId: { type: 'integer', required: true, min: 0, max: 100000000 },
    distance: { type: 'number', required: false, min: 2, max: 32 },
  },
  jump_forward: {
    durationMs: { type: 'integer', required: false, min: 100, max: 2000 },
  },
  stop_movement: {},
  find_block: {
    blockType: { type: 'string', required: true, pattern: NAME_PATTERN, maxLength: 64 },
    radius: { type: 'number', required: false, min: 1, max: 128 },
  },
  find_entity: {
    entityType: { type: 'string', required: false, pattern: NAME_PATTERN, maxLength: 64 },
    hostileOnly: { type: 'boolean', required: false },
    radius: { type: 'number', required: false, min: 1, max: 64 },
  },
  equip_best_melee_weapon: {},
  attack_entity: {
    entityId: { type: 'integer', required: true, min: 0, max: 100000000 },
  },
  stop_attacking: {},
  equip_item: {
    item: ITEM_NAME,
    destination: { type: 'string', required: false, enum: ['hand', 'off-hand', 'head', 'torso', 'legs', 'feet'] },
  },
  inspect_inventory: {},
  eat_best_food: {},
  sleep: {},
  wait: {
    seconds: { type: 'integer', required: true, min: 1, max: 10 },
  },
  mine_block: {
    x: { type: 'number', required: true, min: -30000000, max: 30000000 },
    y: { type: 'number', required: true, min: -64, max: 320 },
    z: { type: 'number', required: true, min: -30000000, max: 30000000 },
  },
  mine_block_type: {
    blockType: { type: 'string', required: true, pattern: NAME_PATTERN, maxLength: 64 },
    count: { type: 'integer', required: false, min: 1, max: 16 },
  },
  craft_item: {
    item: ITEM_NAME,
    count: { type: 'integer', required: false, min: 1, max: 64 },
  },
  place_block: {
    item: ITEM_NAME,
    x: { type: 'number', required: true, min: -30000000, max: 30000000 },
    y: { type: 'number', required: true, min: -64, max: 320 },
    z: { type: 'number', required: true, min: -30000000, max: 30000000 },
    face: { type: 'string', required: false, enum: ['top', 'bottom', 'north', 'south', 'east', 'west'] },
  },
  use_item: {
    item: OPTIONAL_ITEM_NAME,
  },
  chat: {
    message: { type: 'string', required: true, minLength: 1, maxLength: 140 },
  },
};

const PRIMITIVE_NAMES = Object.keys(PRIMITIVE_SCHEMAS);

function validatePrimitiveCall(call) {
  if (!isPlainObject(call)) return { ok: false, error: 'Primitive call must be an object' };
  const name = call.primitive ?? call.name;
  if (typeof name !== 'string' || name.length === 0) {
    return { ok: false, error: 'Missing primitive name' };
  }
  if (!PRIMITIVE_SCHEMAS[name]) {
    return { ok: false, error: `Unknown primitive: ${name}` };
  }
  const rawArgs = call.args ?? {};
  if (!isPlainObject(rawArgs)) return { ok: false, error: `${name}: args must be an object` };

  // Reject dangerous/unexpected fields before anything else.
  for (const key of Object.keys(rawArgs)) {
    if (DANGEROUS_KEY_PATTERN.test(key)) {
      return { ok: false, error: `${name}: forbidden field "${key}"` };
    }
  }
  for (const key of Object.keys(call)) {
    if (key !== 'primitive' && key !== 'name' && key !== 'args') {
      if (DANGEROUS_KEY_PATTERN.test(key)) {
        return { ok: false, error: `${name}: forbidden field "${key}"` };
      }
      return { ok: false, error: `${name}: unexpected field "${key}" (use args)` };
    }
  }

  const schema = PRIMITIVE_SCHEMAS[name];
  for (const key of Object.keys(rawArgs)) {
    if (!schema[key]) {
      return { ok: false, error: `${name}: unexpected argument "${key}"` };
    }
  }
  const value = {};
  for (const [argName, spec] of Object.entries(schema)) {
    if (rawArgs[argName] === undefined) {
      if (spec.required) return { ok: false, error: `${name}: missing required argument "${argName}"` };
      continue;
    }
    const checked = checkValue(spec, rawArgs[argName], `${name}.${argName}`);
    if (!checked.ok) return { ok: false, error: checked.error };
    value[argName] = checked.value;
  }
  // Deep-guard: no nested objects/arrays/functions in validated args.
  for (const [k, v] of Object.entries(value)) {
    if (v !== null && typeof v === 'object') {
      return { ok: false, error: `${name}: argument "${k}" must be a scalar` };
    }
    if (typeof v === 'function') {
      return { ok: false, error: `${name}: argument "${k}" must be data, not code` };
    }
  }
  return { ok: true, value: { primitive: name, args: value } };
}

module.exports = { PRIMITIVE_SCHEMAS, PRIMITIVE_NAMES, validatePrimitiveCall, DANGEROUS_KEY_PATTERN };
