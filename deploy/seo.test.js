const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const fixture = `server {
    listen 443 ssl;
    server_name rogernortconsult.com;
    root /opt/rogernort/nginx/html;
    index index.html;
    location / {
        add_header X-Content-Type-Options nosniff always;
        try_files $uri $uri/ /index.html;
    }
    location /api/ {
        proxy_pass http://127.0.0.1:3000;
    }
}
server {
    server_name www.rogernortconsult.com;
    return 301 https://rogernortconsult.com$request_uri;
}
`;

function transform(input) {
  return spawnSync('awk', ['-f', path.join(__dirname, 'nginx-static-routing.awk')], {
    input, encoding: 'utf8',
  });
}

test('replaces the homepage fallback, preserves other config, and is idempotent', () => {
  const result = transform(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, fixture.replace('try_files $uri $uri/ /index.html;', 'try_files $uri $uri/ =404;'));
  const repeated = transform(result.stdout);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(repeated.stdout, result.stdout);
});

test('refuses unfamiliar or ambiguous routing before installation', () => {
  for (const input of [
    fixture.replace('try_files $uri $uri/ /index.html;', 'try_files $uri @app;'),
    fixture.replace('location / {', 'location /other/ {'),
    fixture + fixture,
    fixture.replace('        try_files', '        location /nested/ {\n        }\n        try_files'),
  ]) {
    const result = transform(input);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /refusing/);
  }
});
