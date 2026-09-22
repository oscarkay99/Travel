'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

process.env.RATE_LIMIT_HASH_SECRET = 'test-only-rate-limit-secret';

const {
  HttpError,
  allowedOrigin,
  clientIp,
  validateApplication,
  validateEnquiry,
  validateChat,
  htmlEscape
} = require('./security');
const { server } = require('./server');

function validApplication(overrides = {}) {
  return {
    fname: 'Ama',
    lname: 'Mensah',
    phone: '+233 55 123 4567',
    age: 29,
    email: 'Ama@example.com',
    country: 'Czech Republic',
    passport: 'Yes, I have a valid passport',
    skills: 'Warehouse work',
    note: 'Available soon',
    website: '',
    formStartedAt: Date.now() - 2_000,
    turnstileToken: '',
    ...overrides
  };
}

test('production origins are allowlisted exactly', () => {
  assert.equal(allowedOrigin('https://rogernortconsult.com'), true);
  assert.equal(allowedOrigin('https://rogernortconsult.com.evil.example'), false);
  assert.equal(allowedOrigin('null'), false);
});

test('Cloudflare connecting IP wins over spoofable forwarding headers', () => {
  const req = {
    headers: { 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '198.51.100.7' },
    socket: { remoteAddress: '127.0.0.1' }
  };
  assert.equal(clientIp(req), '203.0.113.9');
});

test('application validation normalizes fields and enforces the schema', () => {
  const result = validateApplication(validApplication());
  assert.equal(result.email, 'ama@example.com');
  assert.equal(result.age, 29);
  assert.throws(
    () => validateApplication(validApplication({ admin: true })),
    (error) => error instanceof HttpError && error.code === 'UNEXPECTED_FIELDS'
  );
  assert.throws(() => validateApplication(validApplication({ age: 20 })), /between 21 and 55/);
  assert.throws(() => validateApplication(validApplication({ country: 'Unexpected' })), /Country is invalid/);
});

test('enquiry validation rejects malformed contact fields', () => {
  const base = {
    name: 'Kojo Owusu', email: 'kojo@example.com', phone: '055 123 4567', destination: 'Dubai',
    website: '', formStartedAt: Date.now() - 2_000, turnstileToken: ''
  };
  assert.equal(validateEnquiry(base).destination, 'Dubai');
  assert.throws(() => validateEnquiry({ ...base, email: 'not-an-email' }), /valid email/);
  assert.throws(() => validateEnquiry({ ...base, phone: '<script>' }), /valid phone/);
});

test('honeypot submissions are recognized without storing their payload', () => {
  const result = validateApplication(validApplication({ website: 'spam.example' }));
  assert.equal(result.bot, true);
});

test('chat payloads have bounded history and reject extra properties', () => {
  const chat = validateChat({
    message: 'Hello',
    history: [{ role: 'user', content: 'Hi' }],
    sessionId: 'session_1234'
  });
  assert.equal(chat.history.length, 1);
  assert.throws(() => validateChat({ message: 'Hi', debug: true }), /unsupported fields/);
});

test('email HTML escaping neutralizes active markup', () => {
  assert.equal(htmlEscape('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
});

test('browser scripts are syntactically valid and covered by the deployed CSP hashes', () => {
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const nginx = fs.readFileSync(path.join(root, 'deploy/nginx-security-headers.inc'), 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s+type="application\/ld\+json")?>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 3);
  const dubai = fs.readFileSync(path.join(root, 'dubai-holiday-packages-from-accra.html'), 'utf8');
  const packageScripts = [...dubai.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  assert.equal(packageScripts.length, 1);
  assert.doesNotThrow(() => JSON.parse(packageScripts[0][1]));
  scripts.push(...packageScripts);
  assert.doesNotThrow(() => new Function(scripts[0][1]));
  assert.doesNotThrow(() => JSON.parse(scripts[1][1]));
  assert.doesNotThrow(() => JSON.parse(scripts[2][1]));
  for (const [, source] of scripts) {
    const hash = crypto.createHash('sha256').update(source).digest('base64');
    assert.match(nginx, new RegExp(`sha256-${hash.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  }
  assert.doesNotMatch(html, /SUPA_ANON|SUPA_SERVICE_KEY|GEMINI_API_KEY/);
  assert.doesNotMatch(html, /\sonsubmit=/i);
});

test('API status is minimal and untrusted preflight origins are denied', async (t) => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const status = await fetch(`${base}/api/agent/status`);
  assert.deepEqual(await status.json(), { ok: true });
  assert.equal(status.headers.get('x-frame-options'), 'DENY');
  assert.equal(status.headers.get('cache-control'), 'no-store');

  const preflight = await fetch(`${base}/api/apply`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://evil.example' }
  });
  assert.equal(preflight.status, 403);
  assert.equal(preflight.headers.get('access-control-allow-origin'), null);

  const trustedPreflight = await fetch(`${base}/api/apply`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://rogernortconsult.com' }
  });
  assert.equal(trustedPreflight.status, 204);
  assert.equal(trustedPreflight.headers.get('access-control-allow-origin'), 'https://rogernortconsult.com');

  const invalidMethod = await fetch(`${base}/api/apply`);
  assert.equal(invalidMethod.status, 405);

  const wrongType = await fetch(`${base}/api/agent/chat`, {
    method: 'POST',
    headers: { Origin: 'https://rogernortconsult.com', 'Content-Type': 'text/plain' },
    body: 'hello'
  });
  assert.equal(wrongType.status, 415);

  const unexpected = await fetch(`${base}/api/agent/chat`, {
    method: 'POST',
    headers: { Origin: 'https://rogernortconsult.com', 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'Hello', admin: true })
  });
  assert.equal(unexpected.status, 400);

  const oversized = await fetch(`${base}/api/agent/chat`, {
    method: 'POST',
    headers: { Origin: 'https://rogernortconsult.com', 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'x'.repeat(20_000) })
  });
  assert.equal(oversized.status, 413);

  const config = await fetch(`${base}/api/public-config`).then((response) => response.json());
  assert.deepEqual(config, { ok: true, turnstile: { enabled: false } });
});
