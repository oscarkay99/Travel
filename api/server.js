'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { answerUser } = require('./ai/agent');
const {
  HttpError, allowedOrigin, enforceOrigin, clientIp, subjectHash,
  assertPlainObject, validateEnquiry, validateApplication, validateChat,
  htmlEscape, safeHeaderText, verifyTurnstile
} = require('./security');

const RESEND_KEY = process.env.RESEND_API_KEY;
const TO_EMAIL = process.env.TO_EMAIL || 'akwaabatoursa@gmail.com';
const PORT = Number(process.env.PORT) || 3000;
const SUPA_URL = process.env.SUPA_URL || 'http://rogernort-kong:8000';
const SUPA_SERVICE_KEY = process.env.SUPA_SERVICE_KEY;
const SUPA_TIMEOUT_MS = 2_500;
const MAX_BODY_BYTES = 16 * 1024;
const localRateLimits = new Map();

const ROUTES = new Set([
  '/api/agent/status', '/api/public-config', '/api/content',
  '/api/agent/chat', '/api/enquire', '/api/apply'
]);

const RATE_RULES = {
  chat_minute: { limit: 20, windowSeconds: 60 },
  chat_day: { limit: 200, windowSeconds: 86_400 },
  enquiry_hour: { limit: 10, windowSeconds: 3_600 },
  enquiry_day: { limit: 30, windowSeconds: 86_400 },
  application_hour: { limit: 5, windowSeconds: 3_600 },
  application_day: { limit: 10, windowSeconds: 86_400 },
  content_minute: { limit: 60, windowSeconds: 60 }
};

function setApiHeaders(req, res, requestId) {
  const origin = req.headers.origin;
  if (allowedOrigin(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Request-Id', requestId);
}

function sendJson(res, status, payload, extraHeaders = {}) {
  if (res.writableEnded) return;
  for (const [key, value] of Object.entries(extraHeaders)) res.setHeader(key, value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function securityEvent(event, context = {}) {
  console.warn(JSON.stringify({ level: 'security', event, at: new Date().toISOString(), ...context }));
}

function readJson(req) {
  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new HttpError(415, 'Content-Type must be application/json.', 'UNSUPPORTED_MEDIA_TYPE');
  }
  const declaredLength = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new HttpError(413, 'Request body is too large.', 'BODY_TOO_LARGE');
  }
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    let tooLarge = false;
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_BODY_BYTES) { tooLarge = true; return; }
      body += chunk;
    });
    req.on('aborted', () => reject(new HttpError(400, 'Request was interrupted.', 'REQUEST_ABORTED')));
    req.on('error', reject);
    req.on('end', () => {
      if (tooLarge) return reject(new HttpError(413, 'Request body is too large.', 'BODY_TOO_LARGE'));
      try { resolve(assertPlainObject(JSON.parse(body))); }
      catch (error) {
        reject(error instanceof HttpError ? error : new HttpError(400, 'Malformed JSON request.', 'INVALID_JSON'));
      }
    });
  });
}

function supaRequest(method, route, body, { prefer = 'return=minimal', timeoutMs = SUPA_TIMEOUT_MS } = {}) {
  if (!SUPA_SERVICE_KEY) return Promise.reject(new Error('Database service is not configured.'));
  const base = new URL(SUPA_URL);
  if (!['http:', 'https:'].includes(base.protocol)) return Promise.reject(new Error('Database URL is invalid.'));
  const target = new URL(route, `${base.origin}/`);
  const encoded = body === undefined ? null : JSON.stringify(body);
  const lib = target.protocol === 'https:' ? https : http;
  const headers = {
    apikey: SUPA_SERVICE_KEY,
    Authorization: `Bearer ${SUPA_SERVICE_KEY}`,
    'Accept-Profile': 'rogernort',
    'Content-Profile': 'rogernort',
    Accept: 'application/json'
  };
  if (prefer) headers.Prefer = prefer;
  if (encoded !== null) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(encoded);
  }

  return new Promise((resolve, reject) => {
    const request = lib.request({
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method,
      headers
    }, (response) => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { if (responseBody.length < 512 * 1024) responseBody += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const upstreamError = new Error(`Database request returned HTTP ${response.statusCode}.`);
          upstreamError.upstreamStatus = response.statusCode;
          try {
            const parsed = JSON.parse(responseBody);
            if (/^[A-Z0-9_]{2,24}$/.test(String(parsed.code || ''))) upstreamError.upstreamCode = parsed.code;
          } catch (_) {}
          return reject(upstreamError);
        }
        if (!responseBody) return resolve(null);
        try { resolve(JSON.parse(responseBody)); }
        catch (_) { reject(new Error('Database returned an invalid response.')); }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('Database request timed out.')));
    request.on('error', reject);
    if (encoded !== null) request.write(encoded);
    request.end();
  });
}

function supaInsert(table, data) {
  if (!['agent_conversations', 'enquiries', 'applications'].includes(table)) {
    return Promise.reject(new Error('Database table is not allowed.'));
  }
  return supaRequest('POST', `/rest/v1/${table}`, data);
}

function supaRpc(name, parameters) {
  if (!['security_check_rate_limit', 'security_register_submission', 'security_forget_submission'].includes(name)) {
    return Promise.reject(new Error('Database function is not allowed.'));
  }
  return supaRequest('POST', `/rest/v1/rpc/${name}`, parameters, { prefer: null });
}

function checkLocalLimit(scope, subject, rule) {
  const now = Date.now();
  const key = `${scope}:${subject}`;
  const current = localRateLimits.get(key);
  if (!current || current.resetAt <= now) {
    localRateLimits.set(key, { count: 1, resetAt: now + (rule.windowSeconds * 1_000) });
    return { allowed: true, retryAfter: rule.windowSeconds };
  }
  current.count += 1;
  return { allowed: current.count <= rule.limit, retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1_000)) };
}

async function enforceRateLimits(req, scopes, requestId) {
  const ipHash = subjectHash(clientIp(req));
  for (const scope of scopes) {
    const rule = RATE_RULES[scope];
    const local = checkLocalLimit(scope, ipHash, rule);
    if (!local.allowed) {
      securityEvent('rate_limit_exceeded', { requestId, scope, subject: ipHash.slice(0, 12), layer: 'local' });
      const error = new HttpError(429, 'Too many requests. Please try again later.', 'RATE_LIMITED');
      error.retryAfter = local.retryAfter;
      throw error;
    }
  }
  try {
    const results = await Promise.all(scopes.map(async (scope) => {
      const rule = RATE_RULES[scope];
      const result = await supaRpc('security_check_rate_limit', {
        p_scope: scope,
        p_subject_hash: ipHash,
        p_window_seconds: rule.windowSeconds,
        p_limit: rule.limit
      });
      return { scope, result: Array.isArray(result) ? result[0] : result };
    }));
    const denied = results.find(({ result }) => !result || result.allowed !== true);
    if (denied) {
      securityEvent('rate_limit_exceeded', { requestId, scope: denied.scope, subject: ipHash.slice(0, 12), layer: 'distributed' });
      const error = new HttpError(429, 'Too many requests. Please try again later.', 'RATE_LIMITED');
      error.retryAfter = Math.max(1, Number(denied.result?.retry_after) || 60);
      throw error;
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    // Local throttling remains active during a short database outage.
    securityEvent('rate_limit_backend_unavailable', { requestId });
  }
  return ipHash;
}

async function registerSubmission(kind, fingerprint) {
  const result = await supaRpc('security_register_submission', {
    p_kind: kind,
    p_fingerprint: fingerprint,
    p_ttl_seconds: 86_400
  });
  const row = Array.isArray(result) ? result[0] : result;
  return row?.accepted === true;
}

function submissionFingerprint(kind, email, phone) {
  return subjectHash(`${kind}\0${email}\0${phone.replace(/\D/g, '')}`);
}

function sendApplicationEmail(application) {
  if (!RESEND_KEY) return Promise.reject(new Error('Email delivery is not configured.'));
  const safe = Object.fromEntries(Object.entries(application).map(([key, value]) => [key, htmlEscape(value || '')]));
  const whatsappNumber = application.phone.replace(/\D/g, '').replace(/^0/, '233');
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f4f6fb;padding:32px;">
      <div style="background:#1c3669;border-radius:12px;padding:28px 32px;margin-bottom:24px;">
        <h1 style="color:#fff;margin:0;font-size:22px;">New Work Abroad Application</h1>
        <p style="color:#00b8e6;margin:6px 0 0;font-size:14px;">Received from rogernortconsult.com</p>
      </div>
      <div style="background:#fff;border-radius:12px;padding:28px 32px;border:1px solid #dce3f0;">
        <table style="width:100%;border-collapse:collapse;">
          <tr><td>Full Name</td><td><strong>${safe.fname} ${safe.lname}</strong></td></tr>
          <tr><td>WhatsApp</td><td><strong>${safe.phone}</strong></td></tr>
          <tr><td>Age</td><td><strong>${safe.age}</strong></td></tr>
          <tr><td>Email</td><td><strong>${safe.email}</strong></td></tr>
          <tr><td>Country</td><td><strong>${safe.country}</strong></td></tr>
          <tr><td>Passport</td><td><strong>${safe.passport}</strong></td></tr>
          <tr><td>Experience</td><td>${safe.skills || 'Not specified'}</td></tr>
          <tr><td>Notes</td><td>${safe.note || 'None'}</td></tr>
        </table>
      </div>
      <p><a href="https://wa.me/${whatsappNumber}">Reply on WhatsApp</a></p>
      <p>Rogernort Travel &amp; Tour · The Base, New Legon, Adenta</p>
    </div>`;
  const payload = JSON.stringify({
    from: 'Rogernort Applications <onboarding@resend.dev>',
    to: [TO_EMAIL],
    subject: safeHeaderText(`New Work Abroad Application: ${application.fname} ${application.lname} (${application.country})`),
    html
  });
  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: 'api.resend.com', path: '/emails', method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (response) => {
      response.resume();
      response.on('end', () => {
        if (response.statusCode >= 200 && response.statusCode < 300) resolve();
        else reject(new Error(`Email provider returned HTTP ${response.statusCode}.`));
      });
    });
    request.setTimeout(8_000, () => request.destroy(new Error('Email provider timed out.')));
    request.on('error', reject);
    request.end(payload);
  });
}

async function getPublicContent() {
  const [destinations, testimonials] = await Promise.all([
    supaRequest('GET', '/rest/v1/destinations?select=name,region,image_url,price_from,badge&active=eq.true&order=sort_order.asc&limit=6', undefined, { prefer: null }),
    supaRequest('GET', '/rest/v1/testimonials?select=name,destination,rating,content&active=eq.true&order=sort_order.asc&limit=6', undefined, { prefer: null })
  ]);
  return {
    destinations: Array.isArray(destinations) ? destinations : [],
    testimonials: Array.isArray(testimonials) ? testimonials : []
  };
}

async function handleRequest(req, res) {
  const requestId = crypto.randomUUID();
  setApiHeaders(req, res, requestId);
  const url = new URL(req.url, 'http://api.internal');
  const path = url.pathname;
  try {
    if (!ROUTES.has(path)) return sendJson(res, 404, { ok: false, error: 'Not found', requestId });
    if (req.method === 'OPTIONS') {
      if (req.headers.origin && !allowedOrigin(req.headers.origin)) {
        throw new HttpError(403, 'Request origin is not allowed.', 'ORIGIN_DENIED');
      }
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.search) throw new HttpError(400, 'Query parameters are not supported.', 'UNEXPECTED_QUERY');

    if (req.method === 'GET' && path === '/api/agent/status') return sendJson(res, 200, { ok: true });
    if (req.method === 'GET' && path === '/api/public-config') {
      return sendJson(res, 200, {
        ok: true,
        turnstile: process.env.TURNSTILE_SITE_KEY && process.env.TURNSTILE_SECRET_KEY
          ? { enabled: true, siteKey: process.env.TURNSTILE_SITE_KEY }
          : { enabled: false }
      }, { 'Cache-Control': 'public, max-age=300' });
    }
    if (req.method === 'GET' && path === '/api/content') {
      await enforceRateLimits(req, ['content_minute'], requestId);
      return sendJson(res, 200, { ok: true, ...(await getPublicContent()) }, { 'Cache-Control': 'public, max-age=300' });
    }
    if (req.method !== 'POST') {
      return sendJson(res, 405, { ok: false, error: 'Method not allowed', requestId }, { Allow: 'GET, POST, OPTIONS' });
    }

    enforceOrigin(req);
    const data = await readJson(req);
    const remoteIp = clientIp(req);

    if (path === '/api/agent/chat') {
      await enforceRateLimits(req, ['chat_minute', 'chat_day'], requestId);
      const answer = await answerUser(validateChat(data));
      void supaInsert('agent_conversations', {
        session_id: answer.sessionId, user_message: answer.safeInput,
        assistant_message: answer.text, provider: answer.provider, model: answer.model,
        handoff_recommended: answer.handoffRecommended, redactions: answer.redactions
      }).catch(() => securityEvent('conversation_log_failed', { requestId }));
      return sendJson(res, 200, {
        ok: true, sessionId: answer.sessionId, message: answer.text,
        handoffRecommended: answer.handoffRecommended,
        privacyNotice: answer.redactions.length ? 'Sensitive information was removed before processing.' : undefined
      });
    }

    if (path === '/api/enquire') {
      await enforceRateLimits(req, ['enquiry_hour', 'enquiry_day'], requestId);
      const enquiry = validateEnquiry(data);
      if (enquiry.bot) {
        securityEvent('honeypot_triggered', { requestId, endpoint: path });
        return sendJson(res, 200, { ok: true });
      }
      await verifyTurnstile(enquiry.turnstileToken, remoteIp);
      const fingerprint = submissionFingerprint('enquiry', enquiry.email, enquiry.phone);
      if (!(await registerSubmission('enquiry', fingerprint))) {
        securityEvent('duplicate_submission', { requestId, endpoint: path });
        return sendJson(res, 200, { ok: true });
      }
      try {
        await supaInsert('enquiries', {
          name: enquiry.name || null, email: enquiry.email, phone: enquiry.phone,
          destination: enquiry.destination || null
        });
      } catch (error) {
        await supaRpc('security_forget_submission', { p_kind: 'enquiry', p_fingerprint: fingerprint }).catch(() => {});
        throw error;
      }
      return sendJson(res, 200, { ok: true });
    }

    if (path === '/api/apply') {
      await enforceRateLimits(req, ['application_hour', 'application_day'], requestId);
      const application = validateApplication(data);
      if (application.bot) {
        securityEvent('honeypot_triggered', { requestId, endpoint: path });
        return sendJson(res, 200, { ok: true });
      }
      await verifyTurnstile(application.turnstileToken, remoteIp);
      const fingerprint = submissionFingerprint('application', application.email, application.phone);
      if (!(await registerSubmission('application', fingerprint))) {
        securityEvent('duplicate_submission', { requestId, endpoint: path });
        return sendJson(res, 200, { ok: true });
      }
      try {
        await supaInsert('applications', {
          first_name: application.fname, last_name: application.lname,
          phone: application.phone, age: application.age, email: application.email,
          country: application.country, passport: application.passport,
          skills: application.skills || null, notes: application.note || null, status: 'new'
        });
      } catch (error) {
        await supaRpc('security_forget_submission', { p_kind: 'application', p_fingerprint: fingerprint }).catch(() => {});
        throw error;
      }
      try { await sendApplicationEmail(application); }
      catch (_) { securityEvent('application_email_failed', { requestId }); }
      return sendJson(res, 200, { ok: true });
    }
  } catch (error) {
    const status = Number(error.status) || 500;
    if ([403, 413, 429].includes(status)) {
      securityEvent(error.code || 'request_rejected', { requestId, endpoint: path, status });
    } else if (status >= 500) {
      console.error(JSON.stringify({
        level: 'error', event: 'request_failed', requestId, endpoint: path,
        upstreamStatus: Number(error.upstreamStatus) || undefined,
        upstreamCode: error.upstreamCode || undefined
      }));
    }
    return sendJson(res, status, {
      ok: false,
      error: status >= 500 ? 'The service is temporarily unavailable.' : error.message,
      requestId
    }, status === 429 ? { 'Retry-After': String(error.retryAfter || 60) } : {});
  }
}

const server = http.createServer(handleRequest);
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 100;

setInterval(() => {
  const now = Date.now();
  for (const [key, value] of localRateLimits) if (value.resetAt <= now) localRateLimits.delete(key);
}, 60_000).unref();

if (require.main === module) server.listen(PORT, () => console.log(`API running on port ${PORT}`));

module.exports = { server, handleRequest, readJson, sendApplicationEmail };
