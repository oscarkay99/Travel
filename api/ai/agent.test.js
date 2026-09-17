'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

process.env.GEMINI_API_KEY_1 = 'test-only-key';
process.env.GEMINI_MODELS = 'test-model';

describe('Rogernort agent', { concurrency: false }, () => {
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

test('answers newly confirmed commercial rules deterministically', async () => {
  const { answerUser } = require('./agent');
  const cases = [
    ['Is Czech Republic the only active opportunity?', /only currently active country/i],
    ['What is the complete programme cost?', /€6,000/],
    ['When is the €3,000 first payment due?', /immediately after.*documents/i],
    ['What qualifies for a refund?', /offer is not received within 3–6 months/i],
    ['Can I apply without a valid passport?', /valid passport is required/i],
    ['What ban prevents someone from applying?', /banned from Europe/i],
    ['Is the Dubai price per person and where does it depart?', /per person, departing from Accra/i],
    ['Is the official GCB account owned by Rogernort?', /belongs directly to Rogernort/i]
  ];

  for (const [message, expected] of cases) {
    const result = await answerUser({ message });
    assert.equal(result.provider, 'confirmed_business_rule');
    assert.match(result.text, expected);
  }
});

test('does not invent an account number or programme cost breakdown', async () => {
  const { answerUser } = require('./agent');
  const account = await answerUser({ message: 'What is the GCB account number?' });
  const breakdown = await answerUser({ message: 'What does the €6,000 programme cost include?' });

  assert.equal(account.provider, 'deterministic_guardrail');
  assert.equal(breakdown.provider, 'deterministic_guardrail');
  assert.equal(account.handoffRecommended, true);
  assert.equal(breakdown.handoffRecommended, true);
});
});
