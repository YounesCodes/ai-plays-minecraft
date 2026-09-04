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

// Slim reflection contract (reflection-v2): one lesson per call, at most
// one memory, no goal changes, no skill revisions. Goal management belongs
// to cognition/curriculum; skill work belongs to a future separate path.
// The old rich contract failed live ~30% of the time (malformed memory
// subfields, changeGoal without suggestedGoal) — one bad subfield must no
// longer sink the whole reflection.
const REFLECTION_CONTRACT = 'reflection-v2';

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
    '{"summary":"what happened","lesson":"general reusable lesson","memory":null}',
    'or, when genuinely worth remembering:',
    '{"summary":"...","lesson":"...","memory":{"kind":"semantic","subject":"...","content":"...","confidence":0.8}}',
    'memory.kind is "semantic" (fact/lesson) or "episodic" (event summary+lesson). At most one memory. Null when nothing is worth storing.',
    'Top-level keys: exactly summary, lesson, memory. No goal changes, no skill proposals — extras reject the reflection.',
  ].join('\n');
}

function validateReflection(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return { ok: false, error: 'Reflection must be an object' };
  }
  const bad = containsForbidden(output);
  if (bad) return { ok: false, error: `Forbidden field in reflection: "${bad}"` };
  for (const key of Object.keys(output)) {
    if (!['summary', 'lesson', 'memory'].includes(key)) {
      return { ok: false, error: `Unexpected reflection field: "${key}"` };
    }
  }
  if (typeof output.summary !== 'string' || !output.summary.trim() || output.summary.length > 500) {
    return { ok: false, error: 'summary must be a non-empty string (max 500 chars)' };
  }
  if (output.lesson !== undefined && (typeof output.lesson !== 'string' || output.lesson.length > 500)) {
    return { ok: false, error: 'lesson must be a string (max 500 chars)' };
  }
  let memory = null;
  if (output.memory !== undefined && output.memory !== null) {
    const m = output.memory;
    if (!m || typeof m !== 'object' || Array.isArray(m)) {
      return { ok: false, error: 'memory must be an object or null' };
    }
    // Null-intent tolerance: the prompt says to send null when nothing is
    // worth storing; models often send a present-but-textless object
    // instead. Treat all-empty text as null rather than failing the whole
    // reflection (observed live: empty episodic summaries). Wrong kinds,
    // forbidden fields and oversize text still reject.
    if (m.kind === 'semantic' || m.kind === 'episodic') {
      const texts = [m.subject, m.content, m.summary, m.lesson].filter((v) => typeof v === 'string');
      if (texts.length > 0 && texts.every((v) => !v.trim())) {
        return {
          ok: true,
          value: {
            summary: output.summary.trim(),
            lesson: typeof output.lesson === 'string' ? output.lesson.trim() : '',
            memory: null,
          },
        };
      }
    }
    const badInner = containsForbidden(m);
    if (badInner) return { ok: false, error: `Forbidden field in memory: "${badInner}"` };
    if (m.kind !== 'semantic' && m.kind !== 'episodic') {
      return { ok: false, error: 'memory.kind must be semantic|episodic' };
    }
    if (m.kind === 'semantic') {
      if (typeof m.subject !== 'string' || !m.subject.trim() || m.subject.length > 120) {
        return { ok: false, error: 'memory.subject must be non-empty (max 120 chars)' };
      }
      if (typeof m.content !== 'string' || !m.content.trim() || m.content.length > 500) {
        return { ok: false, error: 'memory.content must be non-empty (max 500 chars)' };
      }
      let conf = m.confidence === undefined ? 0.6 : Number(m.confidence);
      if (!Number.isFinite(conf)) return { ok: false, error: 'memory.confidence must be a number 0..1' };
      conf = Math.max(0, Math.min(1, conf));
      memory = { kind: 'semantic', subject: m.subject.trim(), content: m.content.trim(), confidence: conf };
    } else {
      if (typeof m.summary !== 'string' || !m.summary.trim() || m.summary.length > 500) {
        return { ok: false, error: 'memory.summary must be non-empty (max 500 chars)' };
      }
      if (m.lesson !== undefined && (typeof m.lesson !== 'string' || m.lesson.length > 500)) {
        return { ok: false, error: 'memory.lesson must be a string (max 500 chars)' };
      }
      memory = { kind: 'episodic', summary: m.summary.trim(), lesson: typeof m.lesson === 'string' ? m.lesson.trim() : '' };
    }
  }
  return {
    ok: true,
    value: {
      summary: output.summary.trim(),
      lesson: typeof output.lesson === 'string' ? output.lesson.trim() : '',
      memory,
    },
  };
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

module.exports = { buildReflectionPrompt, validateReflection, parseReflectionResponse, shouldReflect, REFLECTION_CONTRACT };
