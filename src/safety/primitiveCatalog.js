'use strict';

// Deterministic model-facing catalog rendered FROM the authoritative
// PRIMITIVE_SCHEMAS (src/safety/primitiveValidator.js). The validator stays
// authoritative; this formatting is derived, so prompt and validator can
// never drift (drift tests enforce it).
//
// Style is compact but complete: every arg, required-vs-optional, types,
// numeric bounds and string enums. Descriptions are passed in (they live in
// src/primitives/index.js) so this module has no dependency cycles.

const { PRIMITIVE_SCHEMAS } = require('./primitiveValidator');

function renderArg(name, spec) {
  const req = spec.required ? 'required' : 'optional';
  const opt = spec.required ? '' : '?';
  switch (spec.type) {
    case 'string': {
      if (Array.isArray(spec.enum)) {
        return `${name}${opt}: ${JSON.stringify(spec.enum)} ${req}`;
      }
      if (spec.pattern) return `${name}${opt}: string (a-z0-9_) ${req}`;
      const bounds = [];
      if (spec.minLength) bounds.push(`>=${spec.minLength} chars`);
      if (spec.maxLength) bounds.push(`<=${spec.maxLength} chars`);
      return `${name}${opt}: string${bounds.length ? ` ${bounds.join(', ')}` : ''} ${req}`.replace(/\s+/g, ' ').trim();
    }
    case 'integer':
    case 'number': {
      const bounds = [];
      if (spec.min !== undefined) bounds.push(spec.min);
      if (spec.max !== undefined) bounds.push(spec.max);
      const range = bounds.length === 2 ? ` ${bounds[0]}..${bounds[1]}` : bounds.length === 1 ? ` ${bounds[0]}..` : '';
      return `${name}${opt}: ${spec.type}${range} ${req}`.replace(/\s+/g, ' ').trim();
    }
    case 'boolean':
      return `${name}${opt}: boolean ${req}`;
    default:
      return `${name}${opt}: ${spec.type || 'unknown'} ${req}`;
  }
}

function renderPrimitive(name) {
  const schema = PRIMITIVE_SCHEMAS[name] || {};
  const args = Object.entries(schema).map(([argName, spec]) => renderArg(argName, spec));
  return `${name}(${args.join(', ')})`;
}

function renderCatalog(descriptions = {}) {
  return Object.keys(PRIMITIVE_SCHEMAS).map((name) => {
    const desc = descriptions[name] ? ` — ${descriptions[name]}` : '';
    return `- ${renderPrimitive(name)}${desc}`;
  });
}

module.exports = { renderArg, renderPrimitive, renderCatalog };
