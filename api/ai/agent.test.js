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
        candidates: [{ content: { parts: [{ text: 'The office is at The Base, New-Legon, Adenta.' }] } }]
      })
    };
  };

  const { answerUser } = require('./agent');
  const result = await answerUser({ message: 'Where is your office?' });
  const outbound = JSON.stringify(request);

  assert.match(outbound, /The Base, New-Legon, Adenta/);
  assert.match(outbound, /All countries/);
  assert.match(outbound, /Appointment booking assistance/);
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
    ['Is the Dubai price per person and where does it depart?', /per person[\s\S]*Accra/i],
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

test('passport requirement words are not treated as identity numbers', () => {
  const { redactSensitiveData } = require('./guardrails');
  assert.deepEqual(redactSensitiveData('passport required for application').redactions, []);
  assert.match(redactSensitiveData('passport number: G1234567').text, /REDACTED passport number/);
});

test('contact details open the callback form without pretending to save a lead', async () => {
  global.fetch = async () => { throw new Error('Contact capture must not call the model'); };
  const { answerUser } = require('./agent');
  for (const message of ['Test Visitor 0200000000', 'Please call me', 'test@example.com', 'I would like a quote for Dubai', 'I want a consultation']) {
    const result = await answerUser({ message });
    assert.equal(result.provider, 'callback_form');
    assert.equal(result.handoffRecommended, true);
    assert.match(result.text, /Request a callback/);
    assert.match(result.text, /does not submit/);
    assert.doesNotMatch(result.safeInput, /0200000000|test@example.com/);
  }
  const accepted = await answerUser({ message: 'Yes please', history: [
    { role: 'assistant', content: 'Would you like to book a free consultation?' }
  ] });
  assert.equal(accepted.provider, 'callback_form');
});

test('historical contact details are redacted without repeating privacy notices', async () => {
  let outbound;
  global.fetch = async (_url, options) => {
    outbound = options.body;
    return { ok: true, json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [
      { thought: true, text: 'Private model reasoning' },
      { text: 'The office is at The Base, New-Legon, Adenta.' }
    ] } }] }) };
  };
  const { answerUser } = require('./agent');
  const result = await answerUser({ message: 'Where is the office?', history: [
    { role: 'assistant', content: 'WhatsApp +233 55 949 9248' },
    { role: 'user', content: 'Test Visitor 0200000000' }
  ] });
  assert.deepEqual(result.redactions, []);
  assert.doesNotMatch(outbound, /0200000000/);
  assert.match(outbound, /REDACTED phone number/);
  assert.doesNotMatch(result.text, /Private model reasoning/);
});

test('never displays a provider response cut off by its token limit', async () => {
  global.fetch = async () => ({ ok: true, json: async () => ({ candidates: [{
    finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'Thank you! A Rogern' }] }
  }] }) });
  const { answerUser } = require('./agent');
  const result = await answerUser({ message: 'Tell me about your office' });
  assert.equal(result.handoffRecommended, true);
  assert.equal(result.provider, 'all_projects_unavailable');
  assert.doesNotMatch(result.text, /Thank you! A Rogern/);
});

});
