'use strict';

const crypto = require('crypto');
const https = require('https');
const { redactSensitiveData } = require('./ai/guardrails');

const PROD_ORIGINS = new Set([
  'https://rogernortconsult.com',
  'https://www.rogernortconsult.com'
]);
const DEV_ORIGINS = new Set(['http://localhost:3000', 'http://localhost:5173']);
const ALLOWED_ORIGINS = process.env.NODE_ENV === 'production'
  ? PROD_ORIGINS
  : new Set([...PROD_ORIGINS, ...DEV_ORIGINS]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^\+?[0-9 ()-]+$/;
const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u;
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

class HttpError extends Error {
  constructor(status, message, code = 'BAD_REQUEST') {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

function allowedOrigin(origin) {
  return typeof origin === 'string' && ALLOWED_ORIGINS.has(origin);
}

function enforceOrigin(req) {
  const origin = req.headers.origin;
  if (origin && !allowedOrigin(origin)) {
    throw new HttpError(403, 'Request origin is not allowed.', 'ORIGIN_DENIED');
  }
}

function clientIp(req) {
  // Cloudflare overwrites this header at the edge. Do not trust a caller-
  // supplied X-Forwarded-For value, which is trivially spoofed.
  const connectingIp = req.headers['cf-connecting-ip'];
  if (typeof connectingIp === 'string' && connectingIp.length <= 64) return connectingIp.trim();
  return (req.socket.remoteAddress || 'unknown').slice(0, 64);
}

function subjectHash(value, secret) {
  const key = secret || process.env.RATE_LIMIT_HASH_SECRET || process.env.SUPA_SERVICE_KEY;
  if (!key) throw new Error('A rate-limit hashing secret is not configured.');
  return crypto.createHmac('sha256', key).update(String(value)).digest('hex');
}

function assertPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new HttpError(400, 'A JSON object is required.', 'INVALID_JSON');
  }
  return value;
}

function exactKeys(value, allowed, required = []) {
  assertPlainObject(value);
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unexpected.length) throw new HttpError(400, 'The request contains unsupported fields.', 'UNEXPECTED_FIELDS');
  const missing = required.filter((key) => !(key in value));
  if (missing.length) throw new HttpError(400, 'Required fields are missing.', 'MISSING_FIELDS');
}

function cleanString(value, field, { min = 0, max, required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new HttpError(400, `${field} is required.`, 'INVALID_FIELD');
    return '';
  }
  if (typeof value !== 'string') throw new HttpError(400, `${field} is invalid.`, 'INVALID_FIELD');
  const cleaned = value.normalize('NFKC').trim().replace(/[ \t]+/g, ' ');
  if (CONTROL_RE.test(cleaned) || cleaned.length < min || (max && cleaned.length > max)) {
    throw new HttpError(400, `${field} is invalid.`, 'INVALID_FIELD');
  }
  if (required && !cleaned) throw new HttpError(400, `${field} is required.`, 'INVALID_FIELD');
  return cleaned;
}

function name(value, field = 'Name', required = true) {
  const cleaned = cleanString(value, field, { min: required ? 1 : 0, max: 80, required });
  if (cleaned && !NAME_RE.test(cleaned)) throw new HttpError(400, `${field} is invalid.`, 'INVALID_FIELD');
  return cleaned;
}

function email(value) {
  const cleaned = cleanString(value, 'Email address', { min: 3, max: 254, required: true }).toLowerCase();
  if (!EMAIL_RE.test(cleaned)) throw new HttpError(400, 'Enter a valid email address.', 'INVALID_EMAIL');
  return cleaned;
}

function phone(value) {
  const cleaned = cleanString(value, 'Phone number', { min: 7, max: 32, required: true });
  const digits = cleaned.replace(/\D/g, '');
  if (!PHONE_RE.test(cleaned) || digits.length < 7 || digits.length > 15) {
    throw new HttpError(400, 'Enter a valid phone number.', 'INVALID_PHONE');
  }
  return cleaned;
}

function oneOf(value, field, options) {
  const cleaned = cleanString(value, field, { min: 1, max: 100, required: true });
  if (!options.includes(cleaned)) throw new HttpError(400, `${field} is invalid.`, 'INVALID_FIELD');
  return cleaned;
}

function antiBotFields(data) {
  const website = cleanString(data.website, 'Website', { max: 200 });
  if (website) return { bot: true, startedAt: 0 };
  const startedAt = Number(data.formStartedAt);
  if (!Number.isFinite(startedAt) || startedAt <= 0 || Date.now() - startedAt < 1_500 || Date.now() - startedAt > 86_400_000) {
    throw new HttpError(400, 'Please refresh the page and try again.', 'FORM_TIMING_INVALID');
  }
  return { bot: false, startedAt };
}

function validateEnquiry(data) {
  exactKeys(data, ['name', 'email', 'phone', 'destination', 'website', 'formStartedAt', 'turnstileToken'], ['email', 'phone']);
  const bot = antiBotFields(data);
  return {
    ...bot,
    name: name(data.name, 'Name', false),
    email: email(data.email),
    phone: phone(data.phone),
    destination: cleanString(data.destination, 'Destination', { max: 120 }),
    turnstileToken: cleanString(data.turnstileToken, 'Verification token', { max: 2_048 })
  };
}

function leadContext(conversation, fallbackInterest) {
  if (!Array.isArray(conversation) || conversation.length > 8) {
    throw new HttpError(400, 'Conversation context is invalid.', 'INVALID_HISTORY');
  }
  const messages = conversation.map((message) =>
    redactSensitiveData(cleanString(message, 'Conversation message', { max: 4_000, required: true })).text
      .replace(/\s+/g, ' '));
  const topics = [
    ['Dubai holiday package', /\bdubai\b/i],
    ['Work abroad assistance', /\b(czech|work abroad|factory|warehouse)\b/i],
    ['Visa assistance', /\bvisa\b/i],
    ['Flight booking', /\b(flight|flights|airfare)\b/i],
    ['Hotel booking', /\b(hotel|hotels|accommodation)\b/i]
  ].filter(([, pattern]) => messages.some((message) => pattern.test(message))).map(([label]) => label);
  return {
    interest: topics.join(', ').slice(0, 120) || redactSensitiveData(fallbackInterest).text || 'AI Concierge chat',
    summary: messages.length ? 'Customer conversation summary (recent message excerpts):\n' +
      messages.map((message) => '- ' + (message.length > 220 ? message.slice(0, 217) + '…' : message)).join('\n') : ''
  };
}

function validateAgentLead(data) {
  exactKeys(data, ['name', 'phone', 'interest', 'conversation', 'website', 'formStartedAt', 'turnstileToken'], ['name', 'phone']);
  const bot = antiBotFields(data);
  return {
    ...bot,
    name: name(data.name, 'Name'),
    phone: phone(data.phone),
    ...leadContext(data.conversation === undefined ? [] : data.conversation, cleanString(data.interest, 'Interest', { max: 120 })),
    turnstileToken: cleanString(data.turnstileToken, 'Verification token', { max: 2_048 })
  };
}

function validateApplication(data) {
  exactKeys(data, [
    'fname', 'lname', 'phone', 'age', 'email', 'country', 'passport', 'skills', 'note',
    'website', 'formStartedAt', 'turnstileToken'
  ], ['fname', 'lname', 'phone', 'age', 'email', 'country', 'passport']);
  const bot = antiBotFields(data);
  const parsedAge = Number(data.age);
  if (!Number.isInteger(parsedAge) || parsedAge < 21 || parsedAge > 55) {
    throw new HttpError(400, 'Applicants must be between 21 and 55 years old.', 'INVALID_AGE');
  }
  return {
    ...bot,
    fname: name(data.fname, 'First name'),
    lname: name(data.lname, 'Last name'),
    phone: phone(data.phone),
    age: parsedAge,
    email: email(data.email),
    country: oneOf(data.country, 'Country', ['Czech Republic', 'Other / Book a consultation']),
    passport: oneOf(data.passport, 'Passport status', ['Yes, I have a valid passport', 'Yes, valid passport']),
    skills: cleanString(data.skills, 'Occupation or experience', { max: 160 }),
    note: cleanString(data.note, 'Notes', { max: 1_000 }),
    turnstileToken: cleanString(data.turnstileToken, 'Verification token', { max: 2_048 })
  };
}

function validateChat(data) {
  exactKeys(data, ['message', 'history', 'sessionId']);
  const message = cleanString(data.message, 'Message', { min: 1, max: 4_000, required: true });
  const history = data.history === undefined ? [] : data.history;
  if (!Array.isArray(history) || history.length > 16) throw new HttpError(400, 'Conversation history is invalid.', 'INVALID_HISTORY');
  const safeHistory = history.map((item) => {
    exactKeys(item, ['role', 'content'], ['role', 'content']);
    if (!['user', 'assistant'].includes(item.role)) throw new HttpError(400, 'Conversation history is invalid.', 'INVALID_HISTORY');
    return { role: item.role, content: cleanString(item.content, 'History message', { max: 4_000 }) };
  });
  const sessionId = data.sessionId === undefined ? undefined : cleanString(data.sessionId, 'Session', { max: 80 });
  if (sessionId && !/^[a-zA-Z0-9_-]{8,80}$/.test(sessionId)) throw new HttpError(400, 'Session is invalid.', 'INVALID_SESSION');
  return { message, history: safeHistory, sessionId };
}

function htmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeHeaderText(value) {
  return String(value).replace(/[\r\n]+/g, ' ').slice(0, 180);
}

function postForm(url, fields, timeoutMs = 5_000) {
  const body = new URLSearchParams(fields).toString();
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (response) => {
      let result = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { if (result.length < 16_384) result += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: result }));
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('Verification timed out.')));
    request.on('error', reject);
    request.end(body);
  });
}

async function verifyTurnstile(token, remoteIp) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  const siteKey = process.env.TURNSTILE_SITE_KEY;
  if (!secret || !siteKey) return { configured: false, success: true };
  if (!token) throw new HttpError(400, 'Please complete the security check.', 'BOT_CHECK_REQUIRED');
  let response;
  try {
    response = await postForm('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      secret,
      response: token,
      remoteip: remoteIp
    });
  } catch (_) {
    throw new HttpError(503, 'The security check is temporarily unavailable. Please try again.', 'BOT_CHECK_UNAVAILABLE');
  }
  let result = {};
  try { result = JSON.parse(response.body); } catch (_) {}
  if (response.status !== 200 || result.success !== true) {
    throw new HttpError(400, 'The security check was not accepted. Please try again.', 'BOT_CHECK_FAILED');
  }
  return { configured: true, success: true };
}

module.exports = {
  ALLOWED_ORIGINS,
  HttpError,
  allowedOrigin,
  enforceOrigin,
  clientIp,
  subjectHash,
  assertPlainObject,
  validateEnquiry,
  validateApplication,
  validateAgentLead,
  validateChat,
  htmlEscape,
  safeHeaderText,
  verifyTurnstile
};
