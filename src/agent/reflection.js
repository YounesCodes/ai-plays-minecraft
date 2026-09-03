'use strict';

// Reflection subsystem: after meaningful events, ask the LLM for structured
// lessons. Output is validated; reflection may SUGGEST memories/goals but
// never writes files or executes code directly.

const FORBIDDEN_KEYS = ['code', 'command', 'cmd', 'exec', 'eval', 'shell', 'file', 'path', 'url', 'script', 'function', 'require', 'process', 'env'];

function containsForbidden(obj) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_KEYS.includes(key.toLowerCase())) return key;
  }
  return null;
}

function buildReflectionPrompt({ goal, stateBefore, attempted, result, stateAfter, relevantMemories }) {
  return [
    'You are reflecting on a Minecraft survival agent\'s recent experience.',
    `Goal: ${JSON.stringify(goal)}`,
    `State before: ${JSON.stringify(stateBefore).slice(0, 2000)}`,
    `Attempted: ${JSON.stringify(attempted).slice(0, 1500)}`,
    `Result: ${JSON.stringify(result).slice(0, 1500)}`,
    `State after: ${JSON.stringify(stateAfter).slice(0, 2000)}`,
    `Relevant memories: ${JSON.stringify(relevantMemories || {}).slice(0, 2000)}`,
    '',
    'Output exactly one JSON object, no commentary:',
    '{"summary":"...","lesson":"...","storeSemanticMemory":true,"semanticMemory":{"subject":"...","content":"...","confidence":0.8},"storeEpisodicMemory":true,"episodicMemory":{"summary":"...","lesson":"..."},"changeGoal":false,"suggestedGoal":null,"suggestedGoalReason":"","reviseSkill":null}',
    'Set store flags false with null payloads when nothing is worth storing.',
    'reviseSkill, if set, must be a full declarative skill object (validated later).',
  ].join('\n');
}

function validateReflection(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return { ok: false, error: 'Reflection must be an object' };
  }
  const bad = containsForbidden(output);
  if (bad) return { ok: false, error: `Forbidden field in reflection: "${bad}"` };
  if (typeof output.summary !== 'string' || !output.summary.trim() || output.summary.length > 1000) {
    return { ok: false, error: 'summary must be a non-empty string (max 1000 chars)' };
  }
  if (output.lesson !== undefined && (typeof output.lesson !== 'string' || output.lesson.length > 1000)) {
    return { ok: false, error: 'lesson must be a string (max 1000 chars)' };
  }
  const out = {
    summary: output.summary.trim(),
    lesson: typeof output.lesson === 'string' ? output.lesson.trim() : '',
    storeSemanticMemory: output.storeSemanticMemory === true,
    semanticMemory: null,
    storeEpisodicMemory: output.storeEpisodicMemory === true,
    episodicMemory: null,
    changeGoal: output.changeGoal === true,
    suggestedGoal: null,
    suggestedGoalReason: '',
    reviseSkill: null,
  };
  if (out.storeSemanticMemory) {
    const m = output.semanticMemory;
    if (!m || typeof m !== 'object') return { ok: false, error: 'semanticMemory must be an object when storeSemanticMemory is true' };
    const badInner = containsForbidden(m);
    if (badInner) return { ok: false, error: `Forbidden field in semanticMemory: "${badInner}"` };
    if (typeof m.subject !== 'string' || !m.subject.trim() || m.subject.length > 120) {
      return { ok: false, error: 'semanticMemory.subject must be non-empty (max 120 chars)' };
    }
    if (typeof m.content !== 'string' || !m.content.trim() || m.content.length > 500) {
      return { ok: false, error: 'semanticMemory.content must be non-empty (max 500 chars)' };
    }
    let conf = m.confidence === undefined ? 0.6 : Number(m.confidence);
    if (!Number.isFinite(conf)) return { ok: false, error: 'semanticMemory.confidence must be a number 0..1' };
    conf = Math.max(0, Math.min(1, conf));
    out.semanticMemory = { subject: m.subject.trim(), content: m.content.trim(), confidence: conf };
  }
  if (out.storeEpisodicMemory) {
    const m = output.episodicMemory;
    if (!m || typeof m !== 'object') return { ok: false, error: 'episodicMemory must be an object when storeEpisodicMemory is true' };
    const badInner = containsForbidden(m);
    if (badInner) return { ok: false, error: `Forbidden field in episodicMemory: "${badInner}"` };
    if (typeof m.summary !== 'string' || !m.summary.trim() || m.summary.length > 500) {
      return { ok: false, error: 'episodicMemory.summary must be non-empty (max 500 chars)' };
    }
    if (m.lesson !== undefined && (typeof m.lesson !== 'string' || m.lesson.length > 500)) {
      return { ok: false, error: 'episodicMemory.lesson must be a string (max 500 chars)' };
    }
    out.episodicMemory = { summary: m.summary.trim(), lesson: typeof m.lesson === 'string' ? m.lesson.trim() : '' };
  }
  if (out.changeGoal) {
    if (typeof output.suggestedGoal !== 'string' || !output.suggestedGoal.trim() || output.suggestedGoal.length > 300) {
      return { ok: false, error: 'suggestedGoal must be non-empty (max 300 chars) when changeGoal is true' };
    }
    out.suggestedGoal = output.suggestedGoal.trim();
    out.suggestedGoalReason = String(output.suggestedGoalReason || '').slice(0, 300);
  }
  if (output.reviseSkill !== undefined && output.reviseSkill !== null) {
    const r = output.reviseSkill;
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      return { ok: false, error: 'reviseSkill must be a skill object or null' };
    }
    const badInner = containsForbidden(r);
    if (badInner) return { ok: false, error: `Forbidden field in reviseSkill: "${badInner}"` };
    // Full skill validation happens in the loop via skillValidator; do a
    // structural pre-check here.
    if (typeof r.id !== 'string' || !Array.isArray(r.steps)) {
      return { ok: false, error: 'reviseSkill must have id and steps' };
    }
    out.reviseSkill = r;
  }
  return { ok: true, value: out };
}

function parseReflectionResponse(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return { ok: false, error: 'Reflection response contained no JSON object' };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch (err) {
    return { ok: false, error: `Reflection response was invalid JSON: ${err.message}` };
  }
  return validateReflection(parsed);
}

// Heuristic: which events deserve an LLM reflection call?
function shouldReflect(event = {}) {
  const triggers = new Set([
    'death', 'combat', 'significant_damage', 'goal_completed', 'repeated_failure',
    'skill_failure', 'mining_failure', 'crafting_failure', 'valuable_discovery',
    'structure_discovery', 'inventory_loss', 'important_item', 'unexpected_success',
  ]);
  if (event.type && triggers.has(event.type)) return true;
  if (event.death) return true;
  if (typeof event.damageTaken === 'number' && event.damageTaken >= 6) return true;
  if (event.goalCompleted) return true;
  if (typeof event.consecutiveFailures === 'number' && event.consecutiveFailures >= 3) return true;
  if (event.skillFailed || event.miningFailed || event.craftingFailed) return true;
  if (event.discoveredValuable || event.discoveredStructure) return true;
  if (event.importantItem) return true;
  return false;
}

module.exports = { buildReflectionPrompt, validateReflection, parseReflectionResponse, shouldReflect };
