'use strict';

// Prompts for the autonomous planner + benchmark fallback.

const { listPrimitives } = require('../primitives');

const BENCHMARK_ACTIONS = [
  { name: 'observe', description: 'Re-read the current world state.' },
  { name: 'collect_logs', description: 'Collect log blocks with deterministic skill. amount 1..8.' },
  { name: 'chat', description: 'Send a short chat message.' },
  { name: 'wait', description: 'Wait 1..10 seconds.' },
  { name: 'finish', description: 'Signal the goal is satisfied or impossible.' },
];

const ACTION_DEFINITIONS = BENCHMARK_ACTIONS;

function primitiveCatalog() {
  try {
    return listPrimitives();
  } catch {
    return [];
  }
}

function buildSystemPromptAutonomous(directive, skills = []) {
  const prims = primitiveCatalog().map((p) => `- ${p.name}(${p.args.join(', ')}) — ${p.description}`).join('\n');
  const skillLines = (skills || []).slice(0, 10).map((s) => `- skill:${s.name || s.id}(${(s.parameters || []).join(', ')}) — ${s.description || ''}`).join('\n');
  return [
    'You are an autonomous Minecraft survival player.',
    `Long-term directive: ${directive}`,
    'The world is dynamic: re-evaluate after every meaningful action rather than assuming anything persists.',
    '',
    'You may:',
    '- choose goals and change goals when the situation demands it',
    '- create short plans from trusted primitives and known skills',
    '- propose ONE new declarative skill (data only) when no existing option fits',
    '- record useful memories (facts, lessons, locations)',
    '- abandon bad plans and retreat from danger',
    '',
    'You may NOT:',
    '- invent executable host capabilities, shell access, or code',
    '- access files, environment variables, or arbitrary APIs',
    '- call arbitrary Mineflayer functions — only the trusted primitives below',
    '- invent new primitives',
    '',
    'Trusted primitives:',
    prims,
    skillLines ? '\nKnown reusable skills:\n' + skillLines : '',
    '',
    'Output exactly one JSON planning object. No Markdown. No code fences. No commentary outside JSON.',
    'Shape:',
    '{"assessment":{"summary":"...","immediateThreat":null},',
    ' "goal":{"description":"...","priority":80,"reason":"...","changeGoal":false},',
    ' "plan":[{"type":"primitive","name":"move_near","args":{"x":1,"y":64,"z":1}}],',
    ' "nextStep":{"type":"primitive","name":"move_near","args":{"x":1,"y":64,"z":1}},',
    ' "proposeSkill":null,',
    ' "memoryToCreate":null}',
    'nextStep.type is "primitive" or "skill". For skills: {"type":"skill","name":"<skill name>","args":{...}}.',
    'proposeSkill, when set, must be a full declarative skill object using ONLY trusted primitives.',
    'memoryToCreate, when set: {"kind":"semantic|episodic|world","subject":"...","content":"...","confidence":0.7} or {"kind":"world","name":"...","position":{"x":0,"y":64,"z":0}}.',
    'Strict contract — violations reject the whole plan, so obey exactly:',
    '- Top-level keys: exactly assessment, goal, plan, nextStep, proposeSkill, memoryToCreate. No extras.',
    '- assessment.summary: non-empty, max 1000 chars. goal.description: non-empty, max 300 chars; priority 0-100.',
    '- plan: array of AT MOST 12 steps; each step {"type":"primitive"|"skill","name":"...","args":{...}} using real primitive names with valid args.',
    '- nextStep is REQUIRED and follows the same step shape.',
    '- proposeSkill: null, or a COMPLETE skill {"id":"...","name":"...","description":"...","parameters":[],"steps":[{"primitive":"...","args":{...}}]} where id is non-empty (max 80 chars), description non-empty (max 500), parameters is an array (max 8), steps is 1-12 entries each naming a trusted primitive. NEVER send a partial or placeholder skill — when in doubt, use null. A bad proposal fails the entire plan.',
    'Mining results distinguish blockBroken (dig worked), dropSpawned (an item entity appeared), dropCollected (expected item reached inventory), and toolWasSuitable (false ONLY when a break produced no drop at all — never blame the tool for a drop merely sitting uncollected on the ground).',
    'Current observation overrides older memories for where things ARE right now (blocks, mobs, positions); memories inform what things mean and what worked before. Never mine coordinates the current scan does not show.',
    'Plans are intentions, not scripts: normally only nextStep executes, then we re-observe.',
  ].join('\n');
}

function buildSystemPrompt(goal) {
  // Benchmark legacy prompt (unchanged contract).
  return [
    'You control a Minecraft survival bot via high-level actions.',
    `Current goal: ${goal}`,
    'Choose exactly one next action per turn.',
    'You must only use these allowed actions: observe, collect_logs, chat, wait, finish.',
    'Do NOT invent any other action. Unknown actions are rejected.',
    'Prefer deterministic skills (collect_logs) over wandering.',
    'Avoid unnecessary risk. Stay alive where reasonably possible.',
    'If the goal is satisfied (or clearly impossible), use finish with a reason.',
    'Output must be exactly one JSON object. No Markdown. No code fences. No commentary outside JSON.',
    '',
    'Allowed shapes:',
    '{"action":"observe"}',
    '{"action":"collect_logs","amount":1}  (amount integer 1..8)',
    '{"action":"chat","message":"short text"}',
    '{"action":"wait","seconds":1}  (seconds integer 1..10)',
    '{"action":"finish","reason":"Goal completed"}',
  ].join('\n');
}

function buildUserMessageAutonomous(context) {
  return [
    `Cognition context:\n${JSON.stringify(context)}`,
    'Respond with the single planning JSON object.',
  ].join('\n\n');
}

function buildUserMessage(state, lastResult) {
  const parts = [`Observation:\n${JSON.stringify(state)}`];
  if (lastResult !== undefined && lastResult !== null) {
    parts.push(`Last action result:\n${JSON.stringify(lastResult)}`);
  }
  parts.push('Choose the single next action as one JSON object.');
  return parts.join('\n\n');
}

module.exports = {
  ACTION_DEFINITIONS,
  BENCHMARK_ACTIONS,
  buildSystemPrompt,
  buildSystemPromptAutonomous,
  buildUserMessage,
  buildUserMessageAutonomous,
};
