'use strict';

// Prompts for the autonomous planner + benchmark fallback.

const { listPrimitives } = require('../primitives');
const { renderCatalog } = require('../safety/primitiveCatalog');

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
  // Compact hot-path contract (autonomous-v2): ONE strategic decision per
  // tick. Argument bounds/enums below are rendered from the authoritative
  // PRIMITIVE_SCHEMAS — copy them exactly, do not improvise values.
  const descriptions = {};
  try {
    for (const p of primitiveCatalog()) descriptions[p.name] = p.description;
  } catch {
    // ignore; catalog renders without descriptions
  }
  const prims = renderCatalog(descriptions).join('\n');
  const skillLines = (skills || []).slice(0, 10).map((s) => `- skill:${s.name || s.id}(${(s.parameters || []).join(', ')}) — ${s.description || ''}`).join('\n');
  return [
    'You are an autonomous Minecraft survival player. Each turn you make ONE compact decision.',
    `Long-term directive: ${directive}`,
    'The world is dynamic: decide from the current observation, then we act and re-observe.',
    '',
    'You may NOT:',
    '- invent host capabilities, shell access, code, files, or arbitrary APIs',
    '- call arbitrary Mineflayer functions — only the trusted primitives below',
    '- invent new primitives or skill names',
    '- travel by boat, raft, or any vehicle (none exist here — move on foot with explore/move_near)',
    '',
    'Trusted primitives (exact arg rules — obey them):',
    prims,
    skillLines ? '\nKnown reusable skills (existing only — never invent names):\n' + skillLines : '\nKnown reusable skills: (none yet — use primitive steps)',
    '',
    'Output exactly one JSON decision object. No Markdown. No code fences. No commentary outside JSON.',
    'Shape:',
    '{"assessment":"short situation summary",',
    ' "goalChange":null,',
    ' "nextStep":{"type":"primitive","name":"mine_block_type","args":{"blockType":"oak_log","count":4}}}',
    'To change goals, set goalChange: {"description":"...","priority":70,"reason":"..."}. Otherwise null. No ceremony.',
    '- nextStep.type is "primitive" or "skill"; skill names must come from the list above.',
    '- Top-level keys: exactly assessment, goalChange, nextStep. No plan, no proposeSkill, no memoryToCreate — extras reject the decision.',
    '- assessment: non-empty, max 500 chars.',
    'Resource signals (from the last action result — do not infer from prose):',
    '- requiresRelocation=true: local targets are exhausted. Strongly prefer explore unless an immediate survival threat overrides.',
    '- resource_not_seen: the resource was not observed locally.',
    '- no_reachable_target: observed but locally unreachable/exhausted.',
    'Exploit before exploring: exploration is for finding what is not locally actionable. If a resource or object relevant to the current goal is already nearby (see nearbyOpportunities), usually exploit it before relocating. Never open with exploration when nearbyOpportunities already lists what the active milestone needs.',
    'Curriculum: pursue the active curriculum milestone (context.curriculum) unless survival demands otherwise. Use current inventory and world state to decide how. Do not attempt later milestones before their prerequisites unless the environment already satisfies them. Exploration is tactical, never the milestone itself.',
    'When your inventory already holds what the active milestone recipe needs, do that step now instead of gathering more of what you have. Craft using the exact status.craftAs item name.',
    'Workstation locality: if the milestone status shows materialsReady with requiresTable and a table nearby (or a known station distance), stay and craft — do not wander off. If no table is nearby but a known station exists, return to it with move_to_known_location. If none is known and you hold a table, place one with place_block_nearby.',
    'Relocation is normally a tactic inside the current goal, not a goal change: keep acquiring wood and explore to find more; change goals only for achievement, impossibility, emergency, or a genuinely more important objective.',
    'If stagnation or oscillation is reported, do not repeat the same strategy unless the new observation gives a concrete reason it will now work.',
    'Grounding rules:',
    '- attack_entity.entityId MUST be copied from a currently observed entity (entityId field). Never invent IDs.',
    '- mine_block coordinates MUST come from the current observation, never from stale memory.',
    '- mine_block_type acquires LOCALLY; distant candidates are deferred by the body.',
    'Mining truth: blockBroken (dig worked) vs dropSpawned (item appeared) vs dropCollected (in inventory) vs toolWasSuitable (false ONLY when no drop appeared at all). Never blame the tool for an uncollected drop on the ground.',
    'Current observation overrides older memories for where things ARE; memories inform what things mean. Never mine coordinates the current scan does not show.',
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
    'Respond with the single decision JSON object (assessment, goalChange, nextStep).',
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
