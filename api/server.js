const http = require('http');

const RESEND_KEY = process.env.RESEND_API_KEY;
const TO_EMAIL   = process.env.TO_EMAIL || 'akwaabatoursa@gmail.com';
const PORT       = process.env.PORT || 3000;

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://rogernortconsult.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method !== 'POST' || req.url !== '/api/apply') {
    res.writeHead(404); res.end('Not found'); return;
  }

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      const { fname, lname, phone, age, email, country, passport, skills, note } = JSON.parse(body);

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
              <tr><td style="padding:10px 0;border-bottom:1px solid #eef2fa;color:#7a85a8;font-size:13px;">Skills</td><td style="padding:10px 0;border-bottom:1px solid #eef2fa;color:#1a2340;font-weight:700;">${skills}</td></tr>
              <tr><td style="padding:10px 0;color:#7a85a8;font-size:13px;vertical-align:top;">Notes</td><td style="padding:10px 0;color:#1a2340;">${note || 'None'}</td></tr>
            </table>
          </div>
          <div style="text-align:center;margin-top:24px;">
            <a href="https://wa.me/233${phone.replace(/^0/,'').replace(/\s/g,'')}"
               style="display:inline-block;background:#25d366;color:#fff;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;">
              💬 Reply on WhatsApp
            </a>
          </div>
          <p style="text-align:center;color:#b0bbcc;font-size:12px;margin-top:20px;">Rogernort Travel &amp; Tour · Adenta New Legon Transformer, Accra</p>
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
        const r = require('https').request(options, resolve);
        r.on('error', reject);
        r.write(payload);
        r.end();
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      console.error(err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false }));
    }
  });
});

server.listen(PORT, () => console.log(`API running on port ${PORT}`));
