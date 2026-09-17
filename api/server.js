const http = require('http');
const https = require('https');
const { answerUser } = require('./ai/agent');
const { getProviderStatus } = require('./ai/router');

const RESEND_KEY       = process.env.RESEND_API_KEY;
const TO_EMAIL         = process.env.TO_EMAIL || 'akwaabatoursa@gmail.com';
const PORT             = process.env.PORT || 3000;
const SUPA_URL         = process.env.SUPA_URL || 'http://supa-kong:8000';
const SUPA_SERVICE_KEY = process.env.SUPA_SERVICE_KEY;
const MAX_BODY_BYTES   = 64 * 1024;
const CHAT_LIMIT       = 20;
const CHAT_WINDOW_MS   = 60 * 1000;
const chatRateLimits   = new Map();

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  return (typeof forwarded === 'string' ? forwarded.split(',')[0] : req.socket.remoteAddress || 'unknown').trim();
}

function chatRateLimited(req) {
  const now = Date.now();
  const key = clientIp(req);
  const current = chatRateLimits.get(key);
  if (!current || current.resetAt <= now) {
    chatRateLimits.set(key, { count: 1, resetAt: now + CHAT_WINDOW_MS });
    return false;
  }
  current.count += 1;
  return current.count > CHAT_LIMIT;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, value] of chatRateLimits) {
    if (value.resetAt <= now) chatRateLimits.delete(key);
  }
}, CHAT_WINDOW_MS).unref();

function supaInsert(table, data) {
  if (!SUPA_SERVICE_KEY) return Promise.resolve();
  const url = new URL(`${SUPA_URL}/rest/v1/${table}`);
  const body = JSON.stringify(data);
  const isHttps = url.protocol === 'https:';
  const lib = isHttps ? https : http;
  const opts = {
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: url.pathname,
    method: 'POST',
    headers: {
      'apikey': SUPA_SERVICE_KEY,
      'Authorization': `Bearer ${SUPA_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Content-Profile': 'rogernort',
      'Content-Length': Buffer.byteLength(body),
      'Prefer': 'return=minimal'
    }
  };
  return new Promise((resolve) => {
    const r = lib.request(opts, (res) => { res.resume(); resolve(); });
    r.on('error', (e) => console.error('Supabase insert error:', e.message));
    r.write(body);
    r.end();
  });
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const allowedOrigins = new Set([
    'https://rogernortconsult.com',
    'https://www.rogernortconsult.com',
    'http://localhost:3000',
    'http://localhost:5173'
  ]);
  if (allowedOrigins.has(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && req.url === '/api/agent/status') {
    const statuses = getProviderStatus();
    sendJson(res, 200, {
      ok: true,
      configuredProjects: statuses.filter((item) => item.configured).length,
      availableProjects: statuses.filter((item) => item.available).length
    });
    return;
  }

  if (req.method !== 'POST') { sendJson(res, 404, { ok: false, error: 'Not found' }); return; }

  if (req.url === '/api/agent/chat' && chatRateLimited(req)) {
    res.setHeader('Retry-After', '60');
    sendJson(res, 429, { ok: false, error: 'Too many messages. Please try again shortly.' });
    return;
  }

  let body = '';
  let bodyTooLarge = false;
  req.on('data', chunk => {
    if (bodyTooLarge) return;
    body += chunk;
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
      bodyTooLarge = true;
      body = '';
    }
  });
  req.on('end', async () => {
    try {
      if (bodyTooLarge) {
        sendJson(res, 413, { ok: false, error: 'Request body is too large.' });
        return;
      }
      const data = JSON.parse(body);

      // ── Grounded AI travel adviser ──
      if (req.url === '/api/agent/chat') {
        const answer = await answerUser({
          message: data.message,
          history: data.history,
          sessionId: data.sessionId
        });

        await supaInsert('agent_conversations', {
          session_id: answer.sessionId,
          user_message: answer.safeInput,
          assistant_message: answer.text,
          provider: answer.provider,
          model: answer.model,
          handoff_recommended: answer.handoffRecommended,
          redactions: answer.redactions
        });

        sendJson(res, 200, {
          ok: true,
          sessionId: answer.sessionId,
          message: answer.text,
          handoffRecommended: answer.handoffRecommended,
          privacyNotice: answer.redactions.length
            ? 'Sensitive information was removed before processing.'
            : undefined
        });
        return;
      }

      // ── Trip Enquiry (CTA form) ──
      if (req.url === '/api/enquire') {
        const { name, email, phone, destination } = data;
        if (!email || !phone) {
          sendJson(res, 400, { ok: false, error: 'Email and phone are required.' });
          return;
        }
        await supaInsert('enquiries', { name: name || null, email, phone, destination: destination || null });
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.url !== '/api/apply') { sendJson(res, 404, { ok: false, error: 'Not found' }); return; }

      const { fname, lname, phone, age, email, country, passport, skills, note } = data;

      const parsedAge = Number(age);
      if (!fname || !lname || !phone || !email || !country || !passport || !Number.isFinite(parsedAge) || parsedAge < 21 || parsedAge > 55) {
        sendJson(res, 400, { ok: false, error: 'Complete applicant details and an age between 21 and 55 are required.' });
        return;
      }

      const html = `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f4f6fb;padding:32px;">
          <div style="background:#1c3669;border-radius:12px;padding:28px 32px;margin-bottom:24px;">
            <h1 style="color:#fff;margin:0;font-size:22px;">🌍 New Work Abroad Application</h1>
            <p style="color:#00b8e6;margin:6px 0 0;font-size:14px;">Received from rogernortconsult.com</p>
          </div>
          <div style="background:#fff;border-radius:12px;padding:28px 32px;border:1px solid #dce3f0;">
            <table style="width:100%;border-collapse:collapse;">
              <tr><td style="padding:10px 0;border-bottom:1px solid #eef2fa;color:#7a85a8;font-size:13px;width:40%;">Full Name</td><td style="padding:10px 0;border-bottom:1px solid #eef2fa;color:#1a2340;font-weight:700;">${fname} ${lname}</td></tr>
              <tr><td style="padding:10px 0;border-bottom:1px solid #eef2fa;color:#7a85a8;font-size:13px;">WhatsApp</td><td style="padding:10px 0;border-bottom:1px solid #eef2fa;color:#1a2340;font-weight:700;">${phone}</td></tr>
              <tr><td style="padding:10px 0;border-bottom:1px solid #eef2fa;color:#7a85a8;font-size:13px;">Age</td><td style="padding:10px 0;border-bottom:1px solid #eef2fa;color:#1a2340;font-weight:700;">${age}</td></tr>
              <tr><td style="padding:10px 0;border-bottom:1px solid #eef2fa;color:#7a85a8;font-size:13px;">Email</td><td style="padding:10px 0;border-bottom:1px solid #eef2fa;color:#1a2340;font-weight:700;">${email || 'Not provided'}</td></tr>
              <tr><td style="padding:10px 0;border-bottom:1px solid #eef2fa;color:#7a85a8;font-size:13px;">Country</td><td style="padding:10px 0;border-bottom:1px solid #eef2fa;"><span style="background:#00b8e6;color:#fff;padding:3px 12px;border-radius:100px;font-size:13px;font-weight:700;">${country}</span></td></tr>
              <tr><td style="padding:10px 0;border-bottom:1px solid #eef2fa;color:#7a85a8;font-size:13px;">Passport</td><td style="padding:10px 0;border-bottom:1px solid #eef2fa;color:#1a2340;font-weight:700;">${passport || 'Not specified'}</td></tr>
              <tr><td style="padding:10px 0;border-bottom:1px solid #eef2fa;color:#7a85a8;font-size:13px;">Experience</td><td style="padding:10px 0;border-bottom:1px solid #eef2fa;color:#1a2340;font-weight:700;">${skills || 'Not specified'}</td></tr>
              <tr><td style="padding:10px 0;color:#7a85a8;font-size:13px;vertical-align:top;">Notes</td><td style="padding:10px 0;color:#1a2340;">${note || 'None'}</td></tr>
            </table>
          </div>
          <div style="text-align:center;margin-top:24px;">
            <a href="https://wa.me/233${phone.replace(/^0/,'').replace(/\s/g,'')}"
               style="display:inline-block;background:#25d366;color:#fff;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;">
              💬 Reply on WhatsApp
            </a>
          </div>
          <p style="text-align:center;color:#b0bbcc;font-size:12px;margin-top:20px;">Rogernort Travel &amp; Tour · The Base, New Legon, Adenta</p>
        </div>`;

      const payload = JSON.stringify({
        from: 'Rogernort Applications <onboarding@resend.dev>',
        to: [TO_EMAIL],
        subject: `🌍 New Work Abroad Application — ${fname} ${lname} (${country})`,
        html
      });

      const options = {
        hostname: 'api.resend.com',
        path: '/emails',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_KEY}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      };

      await new Promise((resolve, reject) => {
        const r = https.request(options, resolve);
        r.on('error', reject);
        r.write(payload);
        r.end();
      });

      await supaInsert('applications', {
        first_name: fname, last_name: lname, phone,
        age: parsedAge,
        email: email || null, country,
        passport: passport || null,
        skills: skills || null, notes: note || null,
        status: 'new'
      });

      sendJson(res, 200, { ok: true });
    } catch (err) {
      const status = err.status || (err instanceof SyntaxError ? 400 : 500);
      if (status >= 500) console.error(err);
      sendJson(res, status, {
        ok: false,
        error: status >= 500 ? 'The service is temporarily unavailable.' : err.message
      });
    }
  });
});

server.listen(PORT, () => console.log(`API running on port ${PORT}`));
