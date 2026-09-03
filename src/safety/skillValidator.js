'use strict';

// Skill validation: declarative JSON only. Rejects unknown primitives, bad
// args, unknown $param references, too many steps, and any executable/host
// payload (code, shell, paths, URLs, env, nesting, loops, recursion).

const { PRIMITIVE_SCHEMAS } = require('./primitiveValidator');

const PARAM_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
const FORBIDDEN_STEP_KEYS = new Set([
  'code', 'javascript', 'js', 'script', 'command', 'cmd', 'exec', 'eval',
  'shell', 'file', 'path', 'url', 'http', 'fetch', 'require', 'import',
  'function', 'method', 'module', 'env', 'process', 'loop', 'while', 'for',
  'goto', 'recurse', 'recursion', 'skill', 'execute', 'run', 'spawn', 'fork',
]);

function getMaxSteps() {
  const v = parseInt(process.env.MAX_SKILL_STEPS || '12', 10);
  if (!Number.isFinite(v)) return 12;
  return Math.max(1, Math.min(24, v));
}

function isParamRef(value) {
  return typeof value === 'string' && value.startsWith('$');
}

function validateSkill(skill, options = {}) {
  const maxSteps = options.maxSteps ?? getMaxSteps();

  if (!skill || typeof skill !== 'object' || Array.isArray(skill)) {
    return { ok: false, error: 'Skill must be an object' };
  }

  const { id, name, description, parameters, steps } = skill;

  if (typeof id !== 'string' || id.trim().length === 0 || id.length > 80) {
    return { ok: false, error: 'Skill id must be a non-empty string (max 80 chars)' };
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) {
    return { ok: false, error: 'Skill id must match [a-z0-9_-]' };
  }
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    return { ok: false, error: 'Skill name must match ^[a-z][a-z0-9_]*$' };
  }
  if (typeof description !== 'string' || description.trim().length === 0 || description.length > 500) {
    return { ok: false, error: 'Skill description must be non-empty (max 500 chars)' };
  }
  if (!Array.isArray(parameters)) {
    return { ok: false, error: 'Skill parameters must be an array' };
  }
  if (parameters.length > 8) {
    return { ok: false, error: 'Skill has too many parameters (max 8)' };
  }
  const paramSet = new Set();
  for (const p of parameters) {
    if (typeof p !== 'string' || !PARAM_PATTERN.test(p)) {
      return { ok: false, error: `Invalid parameter name: ${JSON.stringify(p)}` };
    }
    if (paramSet.has(p)) return { ok: false, error: `Duplicate parameter: ${p}` };
    paramSet.add(p);
  }

  if (!Array.isArray(steps) || steps.length === 0) {
    return { ok: false, error: 'Skill steps must be a non-empty array' };
  }
  if (steps.length > maxSteps) {
    return { ok: false, error: `Skill has too many steps (${steps.length} > ${maxSteps})` };
  }

  // Top-level allowlist: only known metadata keys.
  const allowedTop = new Set(['id', 'name', 'description', 'parameters', 'steps', 'createdAt', 'updatedAt', 'successCount', 'failureCount', 'lastUsedAt', 'score', 'version']);
  for (const key of Object.keys(skill)) {
    if (!allowedTop.has(key)) {
      if (FORBIDDEN_STEP_KEYS.has(key.toLowerCase())) {
        return { ok: false, error: `Forbidden skill field: "${key}"` };
      }
      return { ok: false, error: `Unexpected skill field: "${key}"` };
    }
  }

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const where = `step ${i}`;
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      return { ok: false, error: `${where} must be an object` };
    }
    for (const key of Object.keys(step)) {
      if (key !== 'primitive' && key !== 'args') {
        if (FORBIDDEN_STEP_KEYS.has(key.toLowerCase())) {
          return { ok: false, error: `${where}: forbidden field "${key}"` };
        }
        return { ok: false, error: `${where}: unexpected field "${key}" (only primitive/args allowed)` };
      }
    }
    const prim = step.primitive;
    if (typeof prim !== 'string' || !PRIMITIVE_SCHEMAS[prim]) {
      return { ok: false, error: `${where}: unknown primitive "${String(prim)}"` };
    }
    const args = step.args ?? {};
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return { ok: false, error: `${where}: args must be an object` };
    }
    const schema = PRIMITIVE_SCHEMAS[prim];
    for (const key of Object.keys(args)) {
      if (!schema[key]) {
        if (FORBIDDEN_STEP_KEYS.has(key.toLowerCase())) {
          return { ok: false, error: `${where}: forbidden argument "${key}"` };
        }
        return { ok: false, error: `${where}: unexpected argument "${key}" for ${prim}` };
      }
    }
    for (const [argName, spec] of Object.entries(schema)) {
      const raw = args[argName];
      if (raw === undefined) {
        if (spec.required) {
          // A required arg may be a $param reference instead of a literal.
          return { ok: false, error: `${where}: missing required argument "${argName}" for ${prim}` };
        }
        continue;
      }
      if (isParamRef(raw)) {
        const ref = raw.slice(1);
        if (!PARAM_PATTERN.test(ref) || !paramSet.has(ref)) {
          return { ok: false, error: `${where}: unknown parameter reference "${raw}"` };
        }
        continue;
      }
      // Literal: scalar type check only (full range check happens at execution
      // after substitution; still reject obviously wrong types and objects).
      if (raw !== null && typeof raw === 'object') {
        return { ok: false, error: `${where}: argument "${argName}" must be a scalar or $param reference` };
      }
      if (typeof raw === 'function') {
        return { ok: false, error: `${where}: argument "${argName}" must be data, not code` };
      }
      if (spec.type === 'string' && typeof raw !== 'string') {
        return { ok: false, error: `${where}: argument "${argName}" must be a string or $param reference` };
      }
      if (spec.type === 'integer' && !Number.isInteger(raw)) {
        return { ok: false, error: `${where}: argument "${argName}" must be an integer or $param reference` };
      }
      if (spec.type === 'number' && (typeof raw !== 'number' || !Number.isFinite(raw))) {
        return { ok: false, error: `${where}: argument "${argName}" must be a number or $param reference` };
      }
      if (spec.type === 'boolean' && typeof raw !== 'boolean') {
        return { ok: false, error: `${where}: argument "${argName}" must be a boolean or $param reference` };
      }
    }
  }

  return { ok: true, value: { id, name, description, parameters: [...parameters], steps } };
}

module.exports = { validateSkill, getMaxSteps, FORBIDDEN_STEP_KEYS };
