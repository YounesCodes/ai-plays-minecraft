'use strict';

// Planner: OpenRouter wrapper for both benchmark (single action) and
// autonomous (rich planning object) modes. Never crashes the loop on LLM
// errors; tracks consecutive failures for circuit breaking.

const { complete } = require('../llm/openrouter');
const {
  buildSystemPrompt, buildUserMessage,
  buildSystemPromptAutonomous, buildUserMessageAutonomous,
} = require('./prompts');
const { validateAutonomousDecision, categorizePlannerError } = require('./cognition');
const { autonomousMaxTokens } = require('../safety/limits');
const metrics = require('../telemetry/metrics');

// Slim hot-path contract version for before/after telemetry comparison.
const AUTONOMOUS_CONTRACT = 'autonomous-v2';

// Provider-enforced JSON Schema for the autonomous-v2 STRUCTURAL SHELL only.
// This never replaces local validation: primitive names, argument schemas,
// known skills, and field-level rules are still enforced by
// validateAutonomousDecision afterwards. args stays a free-form object —
// the local primitive schemas remain the single source of truth for args.
function autonomousResponseFormat() {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'autonomous_decision',
      strict: true,
      schema: {
        type: 'object',
        properties: {
          assessment: { type: 'string' },
          goalChange: {
            type: ['object', 'null'],
            properties: {
              description: { type: 'string' },
              priority: { type: 'integer' },
              reason: { type: 'string' },
            },
            required: ['description', 'priority', 'reason'],
            additionalProperties: false,
          },
          nextStep: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['primitive', 'skill'] },
              name: { type: 'string' },
              // Free-form on purpose: primitive argument rules are owned by
              // the local primitive schemas, which stay authoritative. Null
              // args are normalized away by local validation.
              args: { type: ['object', 'null'] },
            },
            required: ['type', 'name', 'args'],
            additionalProperties: false,
          },
        },
        required: ['assessment', 'goalChange', 'nextStep'],
        additionalProperties: false,
      },
    },
  };
}

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

// Autonomous planner: ONE compact decision per tick (contract autonomous-v2),
// validated before return. Skill creation and memory creation are NOT part
// of this response — they run through their own separate paths.
// options.structuredOutput: ask the provider to enforce the autonomous-v2
// shell via response_format json_schema (A/B tested; local validation stays
// authoritative either way).
async function planAutonomous({ context, knownSkillNames = [], temperature = 0.4, structuredOutput = false }) {
  const skills = context?.availableRelevantSkills || [];
  const messages = [
    { role: 'system', content: buildSystemPromptAutonomous(context?.directive, skills) },
    { role: 'user', content: buildUserMessageAutonomous(context) },
  ];
  metrics.inc('llmCalls');
  metrics.inc('plannerCalls');
  let result;
  try {
    result = await complete(messages, {
      temperature,
      maxTokens: autonomousMaxTokens(),
      ...(structuredOutput ? {
        responseFormat: autonomousResponseFormat(),
        // Mechanical requirement for a fair structured-output condition:
        // without this, routing may land on endpoints that treat the schema
        // as a hint (or ignore it), polluting condition B.
        provider: { require_parameters: true },
      } : {}),
    });
  } catch (err) {
    metrics.inc('llmErrors');
    metrics.inc('plannerInvalid');
    try {
      metrics.inc(`plannerInvalid_${categorizePlannerError(err)}`);
    } catch {
      // counter name must never break planning
    }
    throw err;
  }
  const parsed = (() => {
    try {
      return extractJson(result.content);
    } catch (err) {
      metrics.inc('llmErrors');
      metrics.inc('plannerInvalid');
      metrics.inc('plannerInvalid_parse_failure');
      throw err;
    }
  })();
  const check = validateAutonomousDecision(parsed, { knownSkillNames: new Set(knownSkillNames) });
  if (!check.ok) {
    metrics.inc('llmErrors');
    metrics.inc('plannerInvalid');
    try {
      metrics.inc(`plannerInvalid_${categorizePlannerError(new Error(check.error))}`);
    } catch {
      // counter name must never break planning
    }
    const err = new Error(`Planner output failed validation: ${check.error}`);
    err.validationError = check.error;
    err.raw = parsed;
    err.contract = AUTONOMOUS_CONTRACT;
    throw err;
  }
  metrics.inc('plannerValid');
  return { decision: check.value, contract: AUTONOMOUS_CONTRACT, model: result.model, usage: result.usage || null };
}

module.exports = { plan, planAutonomous, extractJson, AUTONOMOUS_CONTRACT, autonomousResponseFormat };
