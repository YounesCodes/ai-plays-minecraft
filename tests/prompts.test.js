'use strict';

// Guards the bug class where the validator rejects what the prompt never
// taught: every enforced numeric bound must be stated in the prompt text.

const test = require('node:test');
const assert = require('node:assert');
const { buildSystemPromptAutonomous } = require('../src/agent/prompts');

test('autonomous prompt states every enforced output bound', () => {
  const prompt = buildSystemPromptAutonomous('test directive');
  for (const needle of [
    '12', // max plan steps / skill steps
    '80', // max skill id chars
    '500', // max skill description chars
    '1000', // max assessment summary chars
    '300', // max goal description chars
    'proposeSkill',
    'nextStep is REQUIRED',
    'toolWasSuitable',
  ]) {
    assert.ok(prompt.includes(needle), `prompt missing constraint: ${needle}`);
  }
});
