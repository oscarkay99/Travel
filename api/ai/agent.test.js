'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.GEMINI_API_KEY_1 = 'test-only-key';
process.env.GEMINI_MODELS = 'test-model';

test('redacts sensitive identity data', () => {
  const { redactSensitiveData } = require('./guardrails');
  const result = redactSensitiveData('Ghana Card GHA-123456789-1, phone 0559499248');

  assert.doesNotMatch(result.text, /123456789|0559499248/);
  assert.deepEqual(result.redactions.sort(), ['Ghana Card number', 'phone number']);
});

test('routes unresolved commercial questions to a human without calling a model', async () => {
  let called = false;
  global.fetch = async () => {
    called = true;
    throw new Error('Model should not be called');
  };

  const { answerUser } = require('./agent');
  const result = await answerUser({ message: 'What GCB account should I pay into?' });

  assert.equal(called, false);
  assert.equal(result.handoffRecommended, true);
  assert.equal(result.provider, 'deterministic_guardrail');
});

test('grounds normal questions in the public knowledge allowlist', async () => {
  let request;
  global.fetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'The office is at The Base, New Legon, Adenta.' }] } }]
      })
    };
  };

  const { answerUser } = require('./agent');
  const result = await answerUser({ message: 'Where is your office?' });
  const outbound = JSON.stringify(request);

  assert.match(outbound, /The Base, New Legon, Adenta/);
  assert.doesNotMatch(outbound, /Official GCB account ownership/);
  assert.equal(result.provider, 'gemini_project_1');
  assert.match(result.text, /The Base/);
});
