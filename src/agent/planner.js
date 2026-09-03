'use strict';

// Planner: OpenRouter wrapper for both benchmark (single action) and
// autonomous (rich planning object) modes. Never crashes the loop on LLM
// errors; tracks consecutive failures for circuit breaking.

const { complete } = require('../llm/openrouter');
const {
  buildSystemPrompt, buildUserMessage,
  buildSystemPromptAutonomous, buildUserMessageAutonomous,
} = require('./prompts');
const { validatePlannerOutput } = require('./cognition');
const metrics = require('../telemetry/metrics');

function stripCodeFences(text) {
  let t = String(text).trim();
  const match = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (match) t = match[1].trim();
  return t;
}

function extractJson(text) {
  const raw = stripCodeFences(text);
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Planner returned non-JSON: ${raw.slice(0, 200)}`);
  }
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new Error(`Planner returned invalid JSON: ${raw.slice(0, 200)}`);
  }
}

// Legacy benchmark planner: single next-action object.
async function plan({ goal, state, lastResult }) {
  const messages = [
    { role: 'system', content: buildSystemPrompt(goal) },
    { role: 'user', content: buildUserMessage(state, lastResult) },
  ];
  metrics.inc('llmCalls');
  let result;
  try {
    result = await complete(messages, { temperature: 0.2 });
  } catch (err) {
    metrics.inc('llmErrors');
    throw err;
  }
  try {
    const parsed = extractJson(result.content);
    if (result.usage) metrics.inc('llmTokens', 0); // placeholder for token accounting
    return parsed;
  } catch (err) {
    metrics.inc('llmErrors');
    throw err;
  }
}

// Autonomous planner: rich planning object, validated before return.
async function planAutonomous({ context, knownSkillNames = [], temperature = 0.4 }) {
  const skills = context?.availableRelevantSkills || [];
  const messages = [
    { role: 'system', content: buildSystemPromptAutonomous(context?.directive, skills) },
    { role: 'user', content: buildUserMessageAutonomous(context) },
  ];
  metrics.inc('llmCalls');
  let result;
  try {
    result = await complete(messages, { temperature });
  } catch (err) {
    metrics.inc('llmErrors');
    throw err;
  }
  const parsed = (() => {
    try {
      return extractJson(result.content);
    } catch (err) {
      metrics.inc('llmErrors');
      throw err;
    }
  })();
  const check = validatePlannerOutput(parsed, { knownSkillNames: new Set(knownSkillNames) });
  if (!check.ok) {
    metrics.inc('llmErrors');
    const err = new Error(`Planner output failed validation: ${check.error}`);
    err.validationError = check.error;
    err.raw = parsed;
    throw err;
  }
  return { plan: check.value, model: result.model, usage: result.usage || null };
}

module.exports = { plan, planAutonomous, extractJson };
