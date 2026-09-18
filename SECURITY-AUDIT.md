# Rogernort Travel & Tour Security Audit

Audit date: 18 September 2026
Scope: `rogernortconsult.com`, its repository, public API, deployment workflow,
and the self-hosted Supabase interfaces used by the application.

## Executive scorecard

| Area | Before | After hardening | Notes |
|---|---:|---:|---|
| Secrets and deployment | 7/10 | 10/10 | No real secret was found in tracked source/history; push protection and protected-branch checks are enabled. |
| API and input security | 4/10 | 9/10 | Strict schemas, limits, safe errors, origin checks and bounded bodies added. |
| Form and bot protection | 2/10 | 7/10 | Distributed limits, timing trap, honeypot and duplicate suppression are active in code; Turnstile awaits its two credentials. |
| Browser/XSS security | 4/10 | 9/10 | Stored-email and CMS DOM injection paths fixed; CSP and framing controls added. |
| Database and personal data | 7/10 | 9/10 | Anonymous PII queries returned zero rows; grants are further restricted and direct browser access removed. |
| Infrastructure edge | 5/10 | 6/10 | TLS is healthy, but the origin remains directly reachable and needs Cloudflare authenticated origin protection. |
| Overall | 5/10 | 8/10 | Materially hardened; two external configuration actions remain. |

The score is a risk-oriented engineering assessment, not a guarantee that no
vulnerability exists.

## Security architecture map

```text
Visitor browser
  -> Cloudflare CDN/TLS
    -> Nginx on Hostinger VPS
      -> static HTML/images
      -> Node.js 24 API container (non-root)
        -> self-hosted Supabase/PostgreSQL via internal Kong URL
        -> Resend email API (fixed destination)
        -> Google Gemini API (five server-side project keys)
        -> Cloudflare Turnstile Siteverify (when credentials are enabled)

GitHub public repository
  -> GitHub Actions secrets
    -> SSH deployment to VPS
      -> database migrations, container rebuild, Nginx reload, smoke tests
```

There is no application login, user account system, payment endpoint, file
upload, package dependency tree, or CMS/admin interface in this repository.

## Findings

### HIGH — HTML injection in application notification email (fixed)

1. **Finding:** Applicant-controlled fields were interpolated directly into an HTML email.
2. **Risk:** A malicious submission could inject misleading links or active HTML into the staff notification.
3. **Evidence:** The previous `/api/apply` template used raw `fname`, `lname`, `phone`, `email`, `skills`, and `note` values.
4. **Affected component:** Node API application-email path.
5. **Fix implemented:** Every dynamic value is schema-validated and HTML-escaped; subject newlines are stripped.
6. **Remaining risk:** Email-client rendering varies, but untrusted markup is now encoded as text.
7. **Future action:** Keep the escaping regression test in CI.

### HIGH — Stored DOM XSS through dynamic content (fixed)

1. **Finding:** Supabase destination and testimonial values were written into `innerHTML` without encoding.
2. **Risk:** A compromised or malformed content record could execute script in visitors' browsers.
3. **Evidence:** Names, regions, badges, testimonial content and image URLs were inserted into template strings.
4. **Affected component:** Homepage dynamic destination/testimonial rendering.
5. **Fix implemented:** Text and attributes are encoded, image URLs use an HTTPS host allowlist, and CSP restricts executable scripts.
6. **Remaining risk:** Static, developer-authored `innerHTML` remains for controlled SVG/typing markup.
7. **Future action:** Prefer DOM node construction for future user-controlled components.

### HIGH — Cloudflare origin bypass (open; manual infrastructure action)

1. **Finding:** The VPS responds to the production hostname when addressed directly, bypassing Cloudflare.
2. **Risk:** Attackers can bypass Cloudflare WAF/rate controls and spoof Cloudflare client-IP headers at the origin.
3. **Evidence:** A single non-destructive direct-origin request returned the live homepage without traversing Cloudflare.
4. **Affected component:** VPS firewall/Nginx and Cloudflare origin authentication.
5. **Fix implemented:** Application-level controls no longer trust `X-Forwarded-For`; distributed throttling remains active behind the proxy.
6. **Remaining risk:** Direct-origin traffic is still possible until cryptographic origin authentication or equivalent network restriction is enabled.
7. **Future action:** Enable Cloudflare Authenticated Origin Pulls for the main hostname and configure Nginx to require the Cloudflare client certificate. Test before enforcing so the owner is not locked out. Keep the intentionally public Supabase hostname separately routed.

### MEDIUM — Public forms lacked complete server validation (fixed)

1. **Finding:** Only a few required fields and the age range were checked server-side.
2. **Risk:** Oversized, malformed, unexpected, or attacker-crafted values could reach email and the database.
3. **Evidence:** `/api/enquire` checked only email/phone presence; `/api/apply` accepted unbounded strings and extra properties.
4. **Affected component:** `/api/apply`, `/api/enquire`, `/api/agent/chat`.
5. **Fix implemented:** Exact property allowlists, Unicode normalization, types, maximum lengths, email/phone/name rules, enums, age bounds, history bounds, content-type enforcement and a 16 KiB request limit.
6. **Remaining risk:** Phone validation is intentionally international and does not prove number ownership.
7. **Future action:** Add OTP verification only if business abuse justifies the added customer friction.

### MEDIUM — In-memory-only API throttling (fixed)

1. **Finding:** Only AI chat was limited, using a process-local map.
2. **Risk:** Restarts or multiple instances reset/bypass limits; forms and public content had no server throttling.
3. **Evidence:** The previous server contained one `chatRateLimits` map.
4. **Affected component:** All public API endpoints.
5. **Fix implemented:** Atomic PostgreSQL fixed-window counters keyed by HMAC IP digests, with a local emergency layer. Limits cover chat, application, enquiry and content endpoints.
6. **Remaining risk:** Fixed windows permit a small burst at window boundaries; direct-origin access weakens IP-header confidence.
7. **Future action:** After origin authentication, tune limits from observed 429 metrics.

### MEDIUM — API database hostname was not resolvable (fixed)

1. **Finding:** The API container used the nonexistent Docker hostname `supa-kong` while the shared-network Kong service is named `rogernort-kong`.
2. **Risk:** Public content returned 500 responses; database form storage, conversation logging, distributed throttling and duplicate suppression could not reach PostgREST.
3. **Evidence:** A zero-row in-container request returned DNS error `EAI_AGAIN`; both containers were confirmed on `rogernort_rogernort-net`, and the real Kong container name was verified without exposing credentials or records.
4. **Affected component:** API-to-Supabase service networking.
5. **Fix implemented:** Production, the server default and `.env.example` now use `http://rogernort-kong:8000`.
6. **Remaining risk:** Docker container naming remains an infrastructure dependency.
7. **Future action:** Keep `/api/content` in the deployment smoke suite; it now prevents a deployment from succeeding when PostgREST is unreachable.

### MEDIUM — No layered bot/duplicate controls (partially fixed)

1. **Finding:** Automated submissions could call forms directly without a challenge, honeypot or duplicate check.
2. **Risk:** Spam, fake applications, database growth and staff-email flooding.
3. **Evidence:** Previous endpoints accepted any valid JSON repeatedly.
4. **Affected component:** Application and trip-enquiry forms.
5. **Fix implemented:** Honeypots, minimum completion time, distributed limits and 24-hour HMAC duplicate suppression. Turnstile client/server verification is implemented.
6. **Remaining risk:** Turnstile remains inactive until both production keys are installed.
7. **Future action:** Create one managed Turnstile widget restricted to `rogernortconsult.com` and `www.rogernortconsult.com`, then add the site/secret keys as GitHub Actions secrets.

### MEDIUM — Missing security response headers (fixed in deployment)

1. **Finding:** Production responses lacked CSP, HSTS, framing, referrer and permissions policies.
2. **Risk:** Increased impact from XSS, clickjacking and content-type confusion.
3. **Evidence:** Pre-change production header inspection returned none of those headers except API `nosniff`.
4. **Affected component:** Nginx/static website and API responses.
5. **Fix implemented:** Allowlist CSP with hashes for inline scripts, `frame-ancestors 'none'`, HSTS without unverified subdomain inclusion, `DENY` framing, `nosniff`, referrer and permissions policies.
6. **Remaining risk:** Inline styles require CSP `style-src 'unsafe-inline'`; scripts do not.
7. **Future action:** Move remaining inline styles to stylesheets, then remove `unsafe-inline` from `style-src`.

### MEDIUM — End-of-life Node.js runtime (fixed)

1. **Finding:** Production and CI used Node.js 20 after its March 2026 end-of-life.
2. **Risk:** The runtime no longer receives upstream security fixes.
3. **Evidence:** `api/Dockerfile` and deployment validation used `node:20-alpine`.
4. **Affected component:** API runtime and deployment tests.
5. **Fix implemented:** Upgraded to Node.js 24 LTS, pinned the official image digest, and configured the container to run as the unprivileged `node` user.
6. **Remaining risk:** The pinned digest must be intentionally refreshed for base-image security updates.
7. **Future action:** Review the base-image digest monthly and after Node security releases.

### MEDIUM — Personal information copied into WhatsApp URLs (fixed)

1. **Finding:** Successful form submissions opened WhatsApp with all form details embedded in a URL.
2. **Risk:** Personal data could enter browser history, external platform logs and URL telemetry unnecessarily.
3. **Evidence:** Client-side templates embedded name, email, phone, occupation and notes in `wa.me` query strings.
4. **Affected component:** Both public forms.
5. **Fix implemented:** Forms now submit only to the protected same-origin API; optional generic WhatsApp links remain separate.
6. **Remaining risk:** Users may independently choose to share information through WhatsApp.
7. **Future action:** Continue collecting only the minimum fields needed.

### MEDIUM — Main branch had no protection (fixed)

1. **Finding:** GitHub reports no protection rule for `main`.
2. **Risk:** An accidental or compromised direct push can deploy immediately to production.
3. **Evidence:** GitHub branch-protection API returned “Branch not protected”.
4. **Affected component:** Source-control and deployment governance.
5. **Fix implemented:** `main` now requires one approving review, the `Security checks` workflow, an up-to-date branch, linear history and resolved conversations. Force-pushes and deletion are disabled.
6. **Remaining risk:** Repository administrators retain a deliberate emergency bypass path.
7. **Future action:** Periodically review administrator access and branch-rule audit events.

### LOW — Public database client configuration in browser (fixed)

1. **Finding:** The browser directly called Supabase with the public anonymous key.
2. **Risk:** The key is designed to be public, but it exposed an unnecessary database attack surface and made policy mistakes more consequential.
3. **Evidence:** Homepage JavaScript contained the anon JWT and Supabase REST URL.
4. **Affected component:** Dynamic content retrieval.
5. **Fix implemented:** Browser access now uses `/api/content`; the backend selects fixed fields from two fixed tables. Anonymous grants for PII tables are explicitly revoked.
6. **Remaining risk:** The Supabase gateway remains publicly reachable for intended services.
7. **Future action:** Periodically enumerate exposed PostgREST functions and storage policies.

### LOW — API metadata and cross-origin behavior (fixed)

1. **Finding:** Public status exposed the number of configured/available model projects, and untrusted preflights received a generic 204.
2. **Risk:** Minor infrastructure reconnaissance and permissive endpoint behavior.
3. **Evidence:** `/api/agent/status` returned project counts; all `OPTIONS` requests succeeded.
4. **Affected component:** API status and CORS handling.
5. **Fix implemented:** Status now returns only `{ok:true}`; untrusted origins receive 403; production allows only the two Rogernort origins.
6. **Remaining risk:** Endpoint existence remains observable, as expected for a public API.
7. **Future action:** None required unless private operational metrics are later added.

### LOW — Duplicate Nginx server-name definitions (fixed)

1. **Finding:** Host Nginx reports duplicate `rogernortconsult.com` and `www.rogernortconsult.com` listeners across legacy site files.
2. **Risk:** Nginx ignores later duplicates, which can cause configuration drift or future changes to be applied to an inactive block.
3. **Evidence:** Live `nginx -t` succeeds but emits conflicting-server-name warnings on ports 80 and 443.
4. **Affected component:** Host Nginx site configuration.
5. **Fix implemented:** The rollback copy that Nginx was mistakenly loading from `sites-enabled` was moved to a root-only backup directory. Future backups are created outside the included configuration directory.
6. **Remaining risk:** None observed; `nginx -t` and the live deployment completed without duplicate-server warnings.
7. **Future action:** Keep rollback files outside `sites-enabled` and `conf.d`.

## Secret and data findings

- `.env` is ignored and is not tracked.
- No high-confidence private API key, private key, provider token or real local secret was found in the current tracked tree.
- Comparing non-empty local environment values against Git history found only non-secret configuration values such as model order, public contact email and internal service URL.
- The repository is public. Anything committed must therefore be considered public.
- GitHub secret scanning and push protection are enabled; non-provider pattern scanning and validity checks are not enabled.
- Supabase anonymous requests to `applications`, `enquiries`, and `agent_conversations` returned a zero-row content range. No personal record was downloaded during the audit.
- Service-role, Gemini, Resend, SSH and Cloudflare secrets remain server-side.

## Endpoint inventory

| Endpoint | Method | Authentication | Main controls |
|---|---|---|---|
| `/api/agent/status` | GET | Public | Minimal response, no-store |
| `/api/public-config` | GET | Public | Returns only public Turnstile site key when enabled |
| `/api/content` | GET | Public | Fixed tables/columns, rate-limited, cached briefly |
| `/api/agent/chat` | POST | Public | Strict schema, redaction, prompt guardrails, minute/day limits |
| `/api/enquire` | POST | Public | Strict schema, origin check, bot controls, duplicate suppression, hour/day limits |
| `/api/apply` | POST | Public | Same controls plus escaped email delivery |

No URL-fetch endpoint, upload endpoint, account endpoint, admin endpoint, test
endpoint or payment endpoint was found. Server-side outbound requests have fixed,
configuration-controlled destinations; no user-controlled SSRF sink was found.

## Verification performed

- Node syntax checks for server and security modules.
- Fourteen automated agent/security tests, including XSS escaping, strict schemas,
  bad origins, invalid methods, wrong content types, unexpected fields and oversized bodies.
- Browser-script syntax and JSON-LD parsing.
- Automated equality check between all inline script hashes and deployed CSP.
- Nginx configuration validation in an isolated official Nginx container.
- Live host-level Nginx validation with automatic rollback before reload.
- Node 24 API image build and non-root UID verification.
- Both SQL migrations applied to a disposable PostgreSQL 17 instance.
- Rate-limit function, duplicate accept/reject behavior and anonymous privilege denial exercised.
- HTTPS redirects, certificate coverage, TLS 1.1 rejection and TLS 1.2/1.3 support checked.
- Production method/CORS/header checks and anonymous RLS row-count checks.
- Successful production workflow run `35317350203`, including API/content/chat smoke tests and Cloudflare cache purge.
- Successful follow-up run `35326845017`, confirming the Nginx duplicate cleanup and Cloudflare capability audit.
- Final external verification: homepage 200, seven hardened header families, minimal status response, and public content returning two destinations and six testimonials.
- Repository secret-pattern and local-value/history comparison without printing secret values.

Destructive database testing, denial-of-service testing, credential brute force,
mailbox/account security, VPS operating-system configuration and unrelated
third-party systems were not tested.

## Required environment variables

Production secret/configuration status:

- `RATE_LIMIT_HASH_SECRET`: dedicated random HMAC key is installed in GitHub Actions and injected server-side.
- `TURNSTILE_SITE_KEY`: public widget key.
- `TURNSTILE_SECRET_KEY`: private server verification key.

Never place real values in `.env.example`, source control, frontend JavaScript or logs.

## Rollback and deployment

- Pre-hardening production rollback commit: `bfcfe7a`.
- Work was isolated on `security-full-hardening-2026-09` before integration.
- The deployment workflow applies idempotent migrations, validates tests and Nginx,
  rebuilds the API, performs live smoke checks and purges Cloudflare cache.
- If a rollback is required, revert the hardening commit and push the revert; the
  added database tables/functions are inert and intentionally not destructively removed.

## Final checklist

- [x] No real secrets found committed or exposed in frontend
- [x] Forms validated server-side with strict schemas and bounds
- [x] Distributed and local rate limiting implemented
- [x] Honeypot, timing and duplicate bot controls active
- [ ] Turnstile active (credentials required)
- [x] Stored/reflected/DOM XSS paths reviewed and identified paths fixed
- [x] SQL construction reviewed; user input is never concatenated into SQL
- [x] CSRF applicability reviewed; no cookie-authenticated endpoints exist, origin checks added
- [x] Authentication/authorization reviewed; no user/admin authentication exists in scope
- [x] Supabase RLS and anonymous PII visibility checked
- [x] CORS allowlist implemented
- [x] CSP and security headers implemented
- [x] HTTPS/TLS/HSTS evaluated
- [x] Clickjacking blocked
- [x] Error messages and logs hardened
- [x] Dependency/runtime audit completed
- [x] API endpoints inventoried
- [x] Personal-data flow reduced
- [x] Secure event logging added without raw IPs or PII
- [x] Production build, migration and configuration checks added
- [x] API-to-PostgREST networking and public-content smoke test verified live
- [x] Main branch protection and pull-request security checks enabled
- [x] Duplicate Nginx configuration removed from the active include directory
- [x] Rollback path preserved
- [ ] Cloudflare origin bypass closed (manual origin-authentication change required)
