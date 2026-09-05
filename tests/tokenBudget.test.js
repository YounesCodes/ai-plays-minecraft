'use strict';

// Planner reliability tests: explicit token budgets reach the OpenRouter
// body, structured-output request shape, and proof that provider-enforced
// structured output can NEVER bypass the local validation chain (primitive
// schemas, known skills, security boundaries).

const test = require('node:test');
const assert = require('node:assert');

// Stub the OpenRouter client BEFORE loading the real planner: capture the
// options the planner passes through.
const openrouterPath = require.resolve('../src/llm/openrouter');
const completeCalls = [];
const stubBehavior = {
  response: { content: '{"assessment":"ok","goalChange":null,"nextStep":{"type":"primitive","name":"wait","args":{"seconds":1}}}', model: 'test-model', usage: { total_tokens: 10 } },
};
require.cache[openrouterPath] = {
  id: openrouterPath,
  filename: openrouterPath,
  loaded: true,
  exports: {
    complete: async (messages, options) => {
      completeCalls.push(options);
      if (stubBehavior.response instanceof Error) throw stubBehavior.response;
      return typeof stubBehavior.response === 'function' ? stubBehavior.response() : stubBehavior.response;
    },
  },
};

const { planAutonomous, autonomousResponseFormat, AUTONOMOUS_CONTRACT } = require('../src/agent/planner');
const { autonomousMaxTokens, reflectionMaxTokens } = require('../src/safety/limits');

const CONTEXT = {
  directive: 'test',
  currentGoal: null,
  state: { self: { health: 20, food: 20, position: { x: 0, y: 64, z: 0 } }, inventory: {}, nearbyEntities: [], interestingBlocks: [], knownLocationsNearby: [] },
  lastResult: null,
  availableRelevantSkills: [],
};

test('autonomous planner sends its own configurable token budget', async () => {
  delete process.env.AUTONOMOUS_MAX_TOKENS;
  completeCalls.length = 0;
  await planAutonomous({ context: CONTEXT, knownSkillNames: [] });
  assert.strictEqual(completeCalls[0].maxTokens, autonomousMaxTokens());
  assert.strictEqual(autonomousMaxTokens(), 1536, 'measured default (DeepSeek p95=826, max=1137)');

  process.env.AUTONOMOUS_MAX_TOKENS = '777';
  try {
    assert.strictEqual(autonomousMaxTokens(), 777);
    completeCalls.length = 0;
    await planAutonomous({ context: CONTEXT, knownSkillNames: [] });
    assert.strictEqual(completeCalls[0].maxTokens, 777, 'env override reaches the OpenRouter body');
  } finally {
    delete process.env.AUTONOMOUS_MAX_TOKENS;
  }
  // Clamp bounds keep runaway config sane.
  process.env.AUTONOMOUS_MAX_TOKENS = '999999';
  try {
    assert.strictEqual(autonomousMaxTokens(), 8192);
  } finally {
    delete process.env.AUTONOMOUS_MAX_TOKENS;
  }
});

test('reflection budget is separate from the planner budget', () => {
  delete process.env.REFLECTION_MAX_TOKENS;
  assert.strictEqual(reflectionMaxTokens(), 1024);
  process.env.REFLECTION_MAX_TOKENS = '600';
  try {
    assert.strictEqual(reflectionMaxTokens(), 600);
    assert.notStrictEqual(reflectionMaxTokens(), autonomousMaxTokens());
  } finally {
    delete process.env.REFLECTION_MAX_TOKENS;
  }
});

test('plain mode sends no response_format and no provider hint', async () => {
  completeCalls.length = 0;
  await planAutonomous({ context: CONTEXT, knownSkillNames: [] });
  assert.strictEqual(completeCalls[0].responseFormat, undefined);
  assert.strictEqual(completeCalls[0].provider, undefined);
});

test('structured mode sends the documented json_schema request shape', async () => {
  completeCalls.length = 0;
  await planAutonomous({ context: CONTEXT, knownSkillNames: [], structuredOutput: true });
  const rf = completeCalls[0].responseFormat;
  assert.strictEqual(rf.type, 'json_schema');
  assert.strictEqual(rf.json_schema.name, 'autonomous_decision');
  assert.strictEqual(rf.json_schema.strict, true);
  const schema = rf.json_schema.schema;
  assert.deepStrictEqual(schema.required, ['assessment', 'goalChange', 'nextStep']);
  assert.strictEqual(schema.additionalProperties, false);
  assert.deepStrictEqual(schema.properties.nextStep.properties.type.enum, ['primitive', 'skill']);
  // args stays free-form: local primitive schemas own argument rules.
  assert.deepStrictEqual(schema.properties.nextStep.properties.args.type, ['object', 'null']);
  // Mechanical routing requirement: only schema-capable endpoints.
  assert.deepStrictEqual(completeCalls[0].provider, { require_parameters: true });
  // Same prompt path in both modes (shape, not content, is asserted here).
  assert.strictEqual(typeof completeCalls[0].temperature, 'number');
});

test('structured output cannot bypass primitive validation (local validator authoritative)', async () => {
  // A provider that enforced only the loose shell would happily return an
  // unknown primitive name — the local validator must still reject it.
  stubBehavior.response = { content: '{"assessment":"ok","goalChange":null,"nextStep":{"type":"primitive","name":"teleport_home","args":{}}}', model: 'm', usage: null };
  try {
    await assert.rejects(
      () => planAutonomous({ context: CONTEXT, knownSkillNames: [], structuredOutput: true }),
      (err) => {
        assert.match(err.validationError, /Unknown primitive/);
        assert.strictEqual(err.contract, AUTONOMOUS_CONTRACT);
        return true;
      }
    );
  } finally {
    stubBehavior.response = { content: '{"assessment":"ok","goalChange":null,"nextStep":{"type":"primitive","name":"wait","args":{"seconds":1}}}', model: 'm', usage: null };
  }
});

test('structured output cannot bypass the forbidden-field security boundary', async () => {
  stubBehavior.response = { content: '{"assessment":"ok","goalChange":null,"nextStep":{"type":"primitive","name":"lookup_recipe","args":{"item":"bread","url":"http://evil.test"}}}', model: 'm', usage: null };
  try {
    await assert.rejects(
      () => planAutonomous({ context: CONTEXT, knownSkillNames: [], structuredOutput: true }),
      (err) => {
        assert.match(err.validationError, /forbidden field/);
        return true;
      }
    );
  } finally {
    stubBehavior.response = { content: '{"assessment":"ok","goalChange":null,"nextStep":{"type":"primitive","name":"wait","args":{"seconds":1}}}', model: 'm', usage: null };
  }
});

test('structured output cannot bypass known-skill validation', async () => {
  stubBehavior.response = { content: '{"assessment":"ok","goalChange":null,"nextStep":{"type":"skill","name":"craft_pickaxe","args":{}}}', model: 'm', usage: null };
  try {
    await assert.rejects(
      () => planAutonomous({ context: CONTEXT, knownSkillNames: [], structuredOutput: true }),
      (err) => /Unknown skill/.test(err.validationError)
    );
  } finally {
    stubBehavior.response = { content: '{"assessment":"ok","goalChange":null,"nextStep":{"type":"primitive","name":"wait","args":{"seconds":1}}}', model: 'm', usage: null };
  }
});

test('autonomousResponseFormat is a pure documented-shape builder', () => {
  const rf = autonomousResponseFormat();
  assert.strictEqual(rf.json_schema.schema.type, 'object');
  assert.ok(Array.isArray(rf.json_schema.schema.properties.goalChange.type));
});
