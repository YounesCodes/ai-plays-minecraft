'use strict';

// Skill generator: builds the LLM prompt for proposing declarative skills and
// parses/validates the JSON response. Generated skills are DATA — validated
// via skillValidator before storage or execution, never eval'd.

const { validateSkill } = require('../safety/skillValidator');
const { listPrimitives } = require('../primitives');

function buildSkillPrompt({ goal, context } = {}) {
  const prims = listPrimitives().map((p) => `- ${p.name}(${p.args.join(', ')}) — ${p.description}`).join('\n');
  return [
    'You design reusable Minecraft strategies as declarative JSON skills.',
    `Goal: ${goal || 'survive and progress'}`,
    context ? `Context: ${JSON.stringify(context).slice(0, 1500)}` : '',
    '',
    'Rules:',
    '- Output exactly one JSON object, no commentary, no code fences.',
    '- The skill may ONLY use these trusted primitives:',
    prims,
    '- Each step: {"primitive": "<name>", "args": {...}}.',
    '- Args may be literals or "$paramName" references declared in "parameters".',
    '- No JavaScript, no shell, no file paths, no URLs, no env vars, no loops, no nested skills.',
    `- Max ${process.env.MAX_SKILL_STEPS || 12} steps, max 8 parameters.`,
    '',
    'Shape:',
    '{"id":"fight-creeper-carefully","name":"fight_creeper_carefully","description":"...","parameters":["targetEntityId"],"steps":[{"primitive":"equip_best_melee_weapon","args":{}}]}',
  ].filter(Boolean).join('\n');
}

function parseSkillResponse(text) {
  const raw = String(text || '').trim();
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return { ok: false, error: 'Skill response contained no JSON object' };
  }
  let parsed;
  try {
    parsed = JSON.parse(stripped.slice(start, end + 1));
  } catch (err) {
    return { ok: false, error: `Skill response was invalid JSON: ${err.message}` };
  }
  const check = validateSkill(parsed);
  if (!check.ok) return { ok: false, error: check.error };
  return { ok: true, skill: parsed };
}

module.exports = { buildSkillPrompt, parseSkillResponse };
