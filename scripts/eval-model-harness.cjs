#!/usr/bin/env node
'use strict';

// Controlled model A/B evaluation for HARNESS LITERACY under the current
// autonomous harness. The ONLY variable is the model: both models receive
// the same system prompt, primitive catalog, context shape, autonomous-v2
// schema, temperature (planner default 0.4), and validation path.
//
// Reused real components (no fake contract):
// - buildContext (src/agent/context)
// - buildSystemPromptAutonomous + primitive catalog (rendered from
//   PRIMITIVE_SCHEMAS inside the planner)
// - planAutonomous (src/agent/planner) = the exact production call path,
//   including extractJson + validateAutonomousDecision + known-skill checks
// - categorizePlannerError for invalid categories
// - the real OpenRouter client
//
// Usage:
//   node --env-file=.env scripts/eval-model-harness.cjs --model <slug> [--reps 8] [--out FILE]
//   OPENROUTER_MODEL=<slug> node scripts/eval-model-harness.cjs
//
// Never prints or stores secrets. Results: logs/model-eval-<timestamp>.json.

const fs = require('fs');
const path = require('path');

const { planAutonomous } = require('../src/agent/planner');
const { categorizePlannerError } = require('../src/agent/cognition');
const { buildContext } = require('../src/agent/context');
const { PRIMITIVE_NAMES } = require('../src/safety/primitiveValidator');
const minecraftData = require('minecraft-data');

const KNOWLEDGE_PRIMITIVES = new Set([
  'lookup_recipe',
  'lookup_uses',
  'search_game_data',
  'lookup_item',
  'lookup_block',
  'lookup_minecraft_reference',
]);

const MC = minecraftData('1.21.11');
function canonicalExists(name) {
  return !!(MC.itemsByName[name] || MC.blocksByName[name]);
}

// A realistic reusable skill mirroring the real collectLogs skill shape
// ({id, name, description, parameters, steps:[{primitive, args}], counters}).
const REAL_SKILL = {
  id: 'collect_logs',
  name: 'collect_logs',
  description: 'Collect nearby log blocks with deterministic steps (1-8 logs).',
  parameters: ['amount'],
  steps: [
    { primitive: 'find_block', args: { blockType: 'oak_log', radius: 48 } },
    { primitive: 'mine_block_type', args: { blockType: 'oak_log', count: 8 } },
  ],
  successCount: 4,
  failureCount: 1,
  score: 0.8,
};

function basePerception(over = {}) {
  return {
    self: { health: 20, food: 20, position: { x: 0, y: 64, z: 0 } },
    equipment: {},
    inventory: {},
    environment: { timeOfDay: 6000, timeCategory: 'day' },
    nearbyEntities: [],
    nearbyEntitiesDetailed: [],
    interestingBlocks: [],
    knownLocationsNearby: [],
    ...over,
  };
}

const TABLE_NEAR = {
  interestingBlocks: [{ type: 'crafting_table', category: 'crafting_table', position: { x: 2, y: 64, z: 1 }, distance: 3 }],
  knownLocationsNearby: [{ name: 'crafting_station', position: { x: 2, y: 64, z: 1 }, metadata: { kind: 'workstation', block: 'crafting_table' } }],
};

const RECIPE_RESULT = {
  ok: true,
  primitive: 'lookup_recipe',
  item: 'wooden_pickaxe',
  source: 'minecraft-data item data for 1.21.11',
  total: 12,
  truncated: true,
  variants: [
    { index: 0, shaped: true, requiresTable: true, shape: [['oak_planks', 'oak_planks', 'oak_planks'], [null, 'stick', null], [null, 'stick', null]], ingredients: { oak_planks: 3, stick: 2 }, output: 'wooden_pickaxe', outputCount: 1 },
    { index: 1, shaped: true, requiresTable: true, shape: [['birch_planks', 'birch_planks', 'birch_planks'], [null, 'stick', null], [null, 'stick', null]], ingredients: { birch_planks: 3, stick: 2 }, output: 'wooden_pickaxe', outputCount: 1 },
  ],
};

// Scenario suite: harness literacy, not a scripted progression. Scoring
// checks legality/coherence; strategic preference is recorded as notes, not
// required for pass.
const SCENARIOS = [
  {
    id: 'A',
    title: 'crafting with no skills (invented-skill temptation)',
    goal: 'Craft a wooden pickaxe',
    knownSkills: [],
    perception: () => basePerception({ inventory: { oak_planks: 6, stick: 2 }, ...TABLE_NEAR }),
    lastResult: () => ({ ok: true, primitive: 'find_block', blockType: 'crafting_table', position: { x: 2, y: 64, z: 1 }, distance: 3 }),
    score: (cls) => {
      const notes = [];
      let pass = cls.valid && !cls.inventedSkill && !cls.inventedPrimitive && !cls.noStep;
      if (cls.inventedSkill) notes.push('invented-skill');
      if (cls.inventedPrimitive) notes.push('invented-primitive');
      if (cls.knowledgeLookup) notes.push(`knowledge:${cls.knowledgeLookup}`);
      if (cls.name === 'craft_item') notes.push('direct-craft');
      if (cls.nonCanonicalItem) { pass = false; notes.push(`non-canonical:${cls.nonCanonicalItem}`); }
      return { pass, notes };
    },
  },
  {
    id: 'B',
    title: 'local mining with no skills',
    goal: 'Acquire stone so I can make stone tools',
    knownSkills: [],
    perception: () => basePerception({
      interestingBlocks: [
        { type: 'stone', category: 'stone', position: { x: 3, y: 63, z: 2 }, distance: 3.6 },
        { type: 'stone', category: 'stone', position: { x: -2, y: 64, z: 4 }, distance: 4.5 },
      ],
    }),
    lastResult: () => ({ ok: true, primitive: 'find_block', blockType: 'stone', position: { x: 3, y: 63, z: 2 }, distance: 3.6 }),
    score: (cls) => {
      const notes = [];
      let pass = cls.valid && cls.legalPrimitiveUse && !cls.inventedSkill && !cls.inventedPrimitive;
      if (['mine_block_type', 'mine_block', 'find_block'].includes(cls.name)) notes.push(`acquisition:${cls.name}`);
      if (cls.inventedSkill) { pass = false; notes.push('invented-skill'); }
      if (cls.inventedPrimitive) { pass = false; notes.push('invented-primitive'); }
      return { pass, notes };
    },
  },
  {
    id: 'C',
    title: 'canonical name uncertainty (search_game_data available)',
    goal: 'Get a pickaxe so I can mine stone. I am not certain what the exact pickaxe item identifier is.',
    knownSkills: [],
    perception: () => basePerception({ inventory: { oak_planks: 6, stick: 2 }, ...TABLE_NEAR }),
    lastResult: () => null,
    score: (cls) => {
      const notes = [];
      let pass = cls.valid && !cls.inventedSkill && !cls.inventedPrimitive;
      if (cls.knowledgeLookup) notes.push(`knowledge:${cls.knowledgeLookup}`);
      if (cls.nonCanonicalItem) { pass = false; notes.push(`non-canonical:${cls.nonCanonicalItem}`); }
      if (cls.legalPrimitiveUse && cls.itemArg && !cls.nonCanonicalItem) notes.push(`canonical:${cls.itemArg}`);
      if (cls.inventedSkill) { pass = false; notes.push('invented-skill'); }
      return { pass, notes };
    },
  },
  {
    id: 'D',
    title: 'recipe uncertainty (lookup_recipe available)',
    goal: 'Craft a compass so I can navigate back to camp',
    knownSkills: [],
    perception: () => basePerception({ inventory: { iron_ingot: 4, redstone: 2 }, ...TABLE_NEAR }),
    lastResult: () => null,
    score: (cls) => {
      const notes = [];
      let pass = cls.valid && !cls.inventedSkill && !cls.inventedPrimitive;
      if (cls.knowledgeLookup) notes.push(`knowledge:${cls.knowledgeLookup}`);
      if (cls.nonCanonicalItem) { pass = false; notes.push(`non-canonical:${cls.nonCanonicalItem}`); }
      if (cls.name === 'craft_item') notes.push(`direct-craft:${cls.itemArg || '?'}`);
      if (cls.inventedSkill) { pass = false; notes.push('invented-skill'); }
      return { pass, notes };
    },
  },
  {
    id: 'E',
    title: 'unknown-skill correction (validator feedback in context)',
    goal: 'Craft a wooden pickaxe',
    knownSkills: [],
    perception: () => basePerception({ inventory: { oak_planks: 6, stick: 2 }, ...TABLE_NEAR }),
    lastResult: () => ({
      ok: false,
      error: 'Unknown skill: craft_pickaxe. Known skills: (none yet — use a primitive step instead)',
      rejectedStep: { type: 'skill', name: 'craft_pickaxe' },
      validationError: 'Invalid nextStep: Unknown skill: craft_pickaxe',
    }),
    recentEvents: () => [{ type: 'skill_rejected', step: 1, detail: 'skill:craft_pickaxe was rejected: no such skill exists and the skill library is empty' }],
    score: (cls) => {
      const notes = [];
      let pass = cls.valid && cls.type !== 'skill' && !cls.inventedSkill && !cls.inventedPrimitive;
      if (cls.type === 'skill') notes.push(cls.inventedSkill ? 'repeated-unknown-skill' : 'skill-again');
      if (cls.knowledgeLookup) notes.push(`knowledge:${cls.knowledgeLookup}`);
      if (cls.name === 'craft_item') notes.push('direct-craft');
      if (!pass && cls.type === 'skill') notes.push('RECOVERY-FAIL');
      return { pass, notes };
    },
  },
  {
    id: 'F',
    title: 'exact known-skill usage (one real skill listed)',
    goal: 'Collect 8 oak logs',
    knownSkills: [REAL_SKILL],
    perception: () => basePerception({
      interestingBlocks: [
        { type: 'oak_log', category: 'log', position: { x: 4, y: 65, z: -3 }, distance: 5.2 },
        { type: 'oak_log', category: 'log', position: { x: 7, y: 65, z: -1 }, distance: 7.5 },
      ],
    }),
    lastResult: () => null,
    score: (cls) => {
      const notes = [];
      let pass = cls.valid && !cls.inventedSkill && !cls.inventedPrimitive;
      if (cls.type === 'skill' && cls.name === 'collect_logs') notes.push('exact-skill');
      if (cls.type === 'skill' && cls.name !== 'collect_logs') { pass = false; notes.push('wrong-skill'); }
      if (['mine_block_type', 'find_block', 'mine_block'].includes(cls.name)) notes.push(`primitive:${cls.name}`);
      if (cls.inventedSkill) { pass = false; notes.push('invented-skill'); }
      return { pass, notes };
    },
  },
  {
    id: 'G',
    title: 'act on a provided recipe result (no re-query)',
    goal: 'Craft a wooden pickaxe',
    knownSkills: [],
    perception: () => basePerception({ inventory: { oak_planks: 6, stick: 4 }, ...TABLE_NEAR }),
    lastResult: () => RECIPE_RESULT,
    score: (cls, decision) => {
      const notes = [];
      let pass = cls.valid && cls.legalPrimitiveUse && !cls.inventedSkill && !cls.inventedPrimitive;
      const reassessed = cls.knowledgeLookup === 'lookup_recipe' && decision?.nextStep?.args?.item === 'wooden_pickaxe';
      if (reassessed) { pass = false; notes.push('repeated-same-lookup'); }
      if (cls.name === 'craft_item' && cls.itemArg === 'wooden_pickaxe') notes.push('acted-on-knowledge');
      if (cls.knowledgeLookup && !reassessed) notes.push(`knowledge:${cls.knowledgeLookup}`);
      if (cls.inventedSkill) { pass = false; notes.push('invented-skill'); }
      return { pass, notes };
    },
  },
  {
    id: 'H',
    title: 'adapt after unknown_item (raft does not exist)',
    goal: 'Escape the water. Craft a raft to get across the river.',
    knownSkills: [],
    perception: () => basePerception({ inventory: { oak_planks: 4 } }),
    lastResult: () => ({ ok: false, primitive: 'lookup_recipe', item: 'raft', reason: 'unknown_item', error: 'Unknown item: raft' }),
    score: (cls, decision) => {
      const notes = [];
      let pass = cls.valid && cls.legalPrimitiveUse && !cls.inventedSkill && !cls.inventedPrimitive;
      const serialized = JSON.stringify(decision?.nextStep || {});
      if (/raft/.test(serialized)) { pass = false; notes.push('repeated-rejected-concept'); }
      if (cls.knowledgeLookup === 'search_game_data' || cls.knowledgeLookup === 'lookup_minecraft_reference') notes.push('sought-alternative');
      if (cls.name === 'craft_item' && cls.itemArg === 'boat') notes.push('switched-to-boat');
      if (cls.nonCanonicalItem) { pass = false; notes.push(`non-canonical:${cls.nonCanonicalItem}`); }
      return { pass, notes };
    },
  },
];

// Classify a nextStep (from a valid decision or the raw parsed output of an
// invalid one). Pure function, exported for tests.
function classifyStep(step, knownSkillNames, valid) {
  const cls = { valid: !!valid };
  if (!step || typeof step !== 'object') {
    cls.noStep = true;
    return cls;
  }
  cls.type = step.type;
  cls.name = step.name;
  if (step.type === 'skill') {
    if (!knownSkillNames.includes(step.name)) cls.inventedSkill = true;
    else cls.legalSkillUse = true;
  } else if (step.type === 'primitive') {
    if (!PRIMITIVE_NAMES.includes(step.name)) cls.inventedPrimitive = true;
    else cls.legalPrimitiveUse = true;
    if (KNOWLEDGE_PRIMITIVES.has(step.name)) cls.knowledgeLookup = step.name;
    const args = step.args || {};
    for (const k of ['item', 'blockType']) {
      if (typeof args[k] === 'string' && args[k].length > 0) {
        cls.itemArg = args[k];
        if (!canonicalExists(args[k])) cls.nonCanonicalItem = args[k];
      }
    }
  }
  return cls;
}

function bound(value, max) {
  if (value === undefined || value === null) return value;
  let s;
  try {
    s = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
  if (s.length <= max) return value;
  return s.slice(0, max) + '…[truncated]';
}

function buildContextFor(sc) {
  return buildContext({
    directive: process.env.AGENT_DIRECTIVE || 'Survive, learn, explore and progress through Minecraft autonomously. Decide your own goals from what you observe, what you know and what you have learned from experience. Avoid unnecessary death.',
    goalState: { currentGoal: { description: sc.goal, priority: 60, reason: 'scenario' }, subgoals: [], suspendedGoal: null },
    perception: sc.perception(),
    lastResult: sc.lastResult(),
    recentEvents: sc.recentEvents ? sc.recentEvents() : [],
    relevantMemories: { semantic: [], episodic: [], procedural: [], world: [] },
    availableSkills: sc.knownSkills,
    exploration: null,
    deathSignal: null,
    actionHistory: [],
    stagnation: { detected: false },
    oscillation: { detected: false },
  });
}

async function runOne(sc, rep, knownSkillNames, structuredOutput = false) {
  const context = buildContextFor(sc);
  const t0 = Date.now();
  let record = { scenario: sc.id, rep, modelRequested: process.env.OPENROUTER_MODEL || null, mode: structuredOutput ? 'structured' : 'plain' };
  let decision = null;
  let raw = null;
  let ok = false;
  let category = null;
  try {
    const res = await planAutonomous({ context, knownSkillNames, structuredOutput });
    decision = res.decision;
    ok = true;
    record.modelReturned = res.model || null;
    record.usage = res.usage || null;
  } catch (err) {
    category = categorizePlannerError(err);
    raw = err.raw !== undefined ? err.raw : null;
    record.validationError = bound(err.validationError || err.message, 300);
    if (err.raw && err.raw.nextStep) decision = err.raw;
  }
  record.latencyMs = Date.now() - t0;
  record.ok = ok;
  if (category) record.category = category;
  const cls = classifyStep(decision ? decision.nextStep : null, knownSkillNames, ok);
  record.klass = cls;
  const scored = sc.score(cls, decision);
  record.pass = scored.pass;
  record.notes = scored.notes;
  if (decision) {
    record.assessment = bound(decision.assessment, 200);
    record.goalChange = decision.goalChange ? { description: bound(decision.goalChange.description, 120), priority: decision.goalChange.priority } : null;
    record.nextStep = decision.nextStep;
  }
  if (!ok && raw !== null && raw !== undefined) {
    record.raw = bound(raw, 1500);
  }
  return record;
}

function aggregate(records) {
  const byModel = {};
  for (const r of records) {
    const m = r.modelReturned || r.modelRequested || 'unknown';
    byModel[m] = byModel[m] || { calls: 0, valid: 0, invalid: 0, categories: {}, inventedSkill: 0, inventedPrimitive: 0, legalPrimitive: 0, legalSkill: 0, knowledge: {}, nonCanonicalItem: 0, pass: 0, latencies: [], tokens: 0, scenarios: {} };
    const a = byModel[m];
    a.calls += 1;
    if (r.ok) a.valid += 1;
    else {
      a.invalid += 1;
      a.categories[r.category || 'other'] = (a.categories[r.category || 'other'] || 0) + 1;
    }
    if (r.klass.inventedSkill) a.inventedSkill += 1;
    if (r.klass.inventedPrimitive) a.inventedPrimitive += 1;
    if (r.klass.legalPrimitiveUse) a.legalPrimitive += 1;
    if (r.klass.legalSkillUse) a.legalSkill += 1;
    if (r.klass.knowledgeLookup) a.knowledge[r.klass.knowledgeLookup] = (a.knowledge[r.klass.knowledgeLookup] || 0) + 1;
    if (r.klass.nonCanonicalItem) a.nonCanonicalItem += 1;
    if (r.pass) a.pass += 1;
    a.latencies.push(r.latencyMs);
    if (r.usage && Number.isFinite(r.usage.total_tokens)) a.tokens += r.usage.total_tokens;
    const s = (a.scenarios[r.scenario] = a.scenarios[r.scenario] || { calls: 0, valid: 0, pass: 0, notes: {} });
    s.calls += 1;
    if (r.ok) s.valid += 1;
    if (r.pass) s.pass += 1;
    for (const n of r.notes) s.notes[n] = (s.notes[n] || 0) + 1;
  }
  for (const a of Object.values(byModel)) {
    a.validPct = Math.round((a.valid / Math.max(1, a.calls)) * 1000) / 10;
    a.passPct = Math.round((a.pass / Math.max(1, a.calls)) * 1000) / 10;
    a.latencies.sort((x, y) => x - y);
    a.medianLatencyMs = a.latencies[Math.floor(a.latencies.length / 2)] || null;
    a.p90LatencyMs = a.latencies[Math.min(a.latencies.length - 1, Math.floor(a.latencies.length * 0.9))] || null;
    delete a.latencies;
  }
  return byModel;
}

async function main() {
  const argv = process.argv.slice(2);
  const argOf = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const model = argOf('--model', null);
  if (model) process.env.OPENROUTER_MODEL = model;
  const reps = Math.max(1, parseInt(argOf('--reps', '8'), 10) || 8);
  const structured = argv.includes('--structured');
  const only = argOf('--only', null);
  const scenarios = only ? SCENARIOS.filter((s) => only.split(',').includes(s.id)) : SCENARIOS;
  if (!process.env.OPENROUTER_MODEL) {
    console.error('No model specified: pass --model <slug> or set OPENROUTER_MODEL.');
    process.exit(2);
  }
  if (!process.env.OPENROUTER_API_KEY) {
    console.error('OPENROUTER_API_KEY missing (use node --env-file=.env). Never print it.');
    process.exit(2);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const modeTag = structured ? 'structured' : 'plain';
  const outFile = argOf('--out', path.join('logs', `model-eval-${modeTag}-${stamp}.json`));
  console.log(JSON.stringify({ eval: 'model-harness', model: process.env.OPENROUTER_MODEL, reps, mode: modeTag, scenarios: scenarios.map((s) => s.id), temperature: 0.4 }));

  const records = [];
  for (let rep = 1; rep <= reps; rep++) {
    for (const sc of scenarios) {
      const knownSkillNames = sc.knownSkills.map((s) => s.name).concat(sc.knownSkills.map((s) => s.id));
      const record = await runOne(sc, rep, knownSkillNames, structured);
      records.push(record);
      console.log(JSON.stringify({ scenario: sc.id, rep, ok: record.ok, pass: record.pass, category: record.category || null, next: record.nextStep ? `${record.nextStep.type}:${record.nextStep.name}` : null, notes: record.notes, latencyMs: record.latencyMs }));
    }
  }

  const summary = aggregate(records);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({ eval: 'model-harness', model: process.env.OPENROUTER_MODEL, reps, mode: modeTag, temperature: 0.4, summary, records }, null, 1));
  console.log(JSON.stringify({ summary: true, file: outFile, byModel: summary }));
}

if (require.main === module) {
  main().catch((e) => {
    console.error(JSON.stringify({ error: String((e && e.message) || e).slice(0, 300) }));
    process.exit(1);
  });
}

module.exports = { SCENARIOS, classifyStep, buildContextFor, canonicalExists, REAL_SKILL, KNOWLEDGE_PRIMITIVES };
