'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const messages = [{ role: 'user', content: 'Where is the office?' }];
const success = () => ({ ok: true, json: async () => ({ candidates: [{
  finishReason: 'STOP', content: { parts: [{ text: 'Approved answer' }] }
}] }) });
const failure = (status) => ({ ok: false, status, headers: { get: () => null }, json: async () => ({}) });

function setup(t) {
  const previousEnv = { ...process.env };
  const previousFetch = global.fetch;
  process.env.AI_PROVIDER_ORDER = 'gemini_project_1,gemini_project_2';
  process.env.GEMINI_API_KEY_1 = 'test-key-one';
  process.env.GEMINI_API_KEY_2 = 'test-key-two';
  process.env.GEMINI_MODELS_1 = 'first,second';
  process.env.GEMINI_MODELS_2 = 'first,second';
  process.env.AI_MODEL_TIMEOUT_MS = '7000';
  process.env.AI_PROVIDER_COOLDOWN_MS = '60000';
  for (const file of ['./router', './providers']) delete require.cache[require.resolve(file)];
  t.after(() => {
    global.fetch = previousFetch;
    for (const name of Object.keys(process.env)) if (!(name in previousEnv)) delete process.env[name];
    Object.assign(process.env, previousEnv);
  });
  return require('./router');
}

function route(url, options) {
  return `${options.headers['x-goog-api-key']}/${decodeURIComponent(new URL(url).pathname.split('/').at(-1))}`;
}

test('later messages go straight to the model that worked', async (t) => {
  const { generate } = setup(t);
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push(route(url, options));
    return calls.length === 1 ? failure(404) : success();
  };
  await generate(messages);
  await generate(messages);
  assert.deepEqual(calls, ['test-key-one/first:generateContent', 'test-key-one/second:generateContent', 'test-key-one/second:generateContent']);
});

test('authentication failures skip the remaining models and remember the working project', async (t) => {
  const { generate } = setup(t);
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push(route(url, options));
    return options.headers['x-goog-api-key'] === 'test-key-one' ? failure(403) : success();
  };
  await generate(messages);
  await generate(messages);
  assert.deepEqual(calls, ['test-key-one/first:generateContent', 'test-key-two/first:generateContent', 'test-key-two/first:generateContent']);
});

test('failed models are skipped during cooldown and become eligible after it expires', async (t) => {
  const { generate } = setup(t);
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  t.after(() => { Date.now = realNow; });
  let calls = 0;
  global.fetch = async () => { calls++; return failure(404); };
  await assert.rejects(generate(messages), { code: 'AI_PROVIDERS_EXHAUSTED' });
  assert.equal(calls, 4);
  await assert.rejects(generate(messages), { code: 'AI_PROVIDERS_EXHAUSTED' });
  assert.equal(calls, 4);
  now += 60_001;
  global.fetch = async () => { calls++; return success(); };
  assert.equal((await generate(messages)).text, 'Approved answer');
  assert.equal(calls, 5);
});

test('a failing preferred model falls back without retrying a known failed model', async (t) => {
  const { generate } = setup(t);
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push(route(url, options));
    return calls.length === 1 || calls.length === 3 ? failure(404) : success();
  };
  await generate(messages);
  const result = await generate(messages);
  assert.equal(result.provider, 'gemini_project_2');
  assert.deepEqual(calls, ['test-key-one/first:generateContent', 'test-key-one/second:generateContent', 'test-key-one/second:generateContent', 'test-key-two/first:generateContent']);
});

test('a timed-out project gives another project a chance', async (t) => {
  const { generate } = setup(t);
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push(route(url, options));
    if (calls.length === 1) throw Object.assign(new Error('Timed out'), { name: 'AbortError' });
    return success();
  };
  assert.equal((await generate(messages)).provider, 'gemini_project_2');
  assert.deepEqual(calls, ['test-key-one/first:generateContent', 'test-key-two/first:generateContent']);
});

test('the overall deadline aborts a hanging request', async (t) => {
  const { generate } = setup(t);
  global.fetch = async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('Timed out'), { name: 'AbortError' })), { once: true });
  });
  const start = Date.now();
  await assert.rejects(generate(messages, { totalTimeoutMs: 300 }), { code: 'AI_PROVIDERS_EXHAUSTED' });
  assert.ok(Date.now() - start < 2000, 'must respect the shared deadline instead of the 7-second model timeout');
});
