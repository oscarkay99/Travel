'use strict';

// Thin wrapper over the TikTok API for Business (v1.3). Endpoint shapes follow
// the Business Messaging and Accounts (comment) APIs as used by the
// open-source Chatwoot and ChatbotX TikTok integrations.

const BASE_URL = process.env.TIKTOK_API_BASE_URL || 'https://business-api.tiktok.com/open_api/v1.3';
const AUTHORIZE_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const REQUEST_TIMEOUT_MS = 10_000;

// Never request a scope the app has not been approved for: TikTok rejects the
// whole authorize request over a single unapproved scope.
const DM_SCOPES = ['user.info.basic', 'user.info.username', 'message.list.read', 'message.list.send', 'message.list.manage'];
const COMMENT_SCOPES = ['comment.list', 'comment.list.manage'];

class TikTokApiError extends Error {
  constructor(endpoint, message, { status, code } = {}) {
    super(`${endpoint}: ${message}`);
    this.name = 'TikTokApiError';
    this.endpoint = endpoint;
    this.status = status || null;
    this.code = code ?? null;
  }
}

// TikTok ids are 19-digit snowflakes that JSON.parse silently rounds. Quote any
// bare integer of 16+ digits before parsing; timestamps (13 digits) are untouched.
function parseTikTokJson(text) {
  const raw = String(text);
  try {
    return JSON.parse(raw.replace(/(:\s*|\[\s*|,\s*)(\d{16,})(?=\s*[,}\]])/g, '$1"$2"'));
  } catch (_) {
    // The pattern can match inside a string value (a customer typing a long
    // number) and break the JSON; ids inside such a payload are strings anyway.
    return JSON.parse(raw);
  }
}

async function call(endpoint, { method = 'GET', query, body, accessToken } = {}) {
  const url = new URL(`${BASE_URL}/${endpoint}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, Array.isArray(value) ? JSON.stringify(value) : String(value));
  }
  const headers = { Accept: 'application/json' };
  if (accessToken) headers['Access-Token'] = accessToken;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  let text;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
    text = await response.text();
  } catch (error) {
    throw new TikTokApiError(endpoint, error.name === 'AbortError' ? 'request timed out' : 'request failed');
  } finally {
    clearTimeout(timer);
  }

  let payload;
  try { payload = parseTikTokJson(text); }
  catch (_) { throw new TikTokApiError(endpoint, 'invalid JSON response', { status: response.status }); }
  // The Business API answers HTTP 200 for rejected calls; `code` is the verdict.
  if (!response.ok || payload.code !== 0) {
    throw new TikTokApiError(endpoint, String(payload.message || `HTTP ${response.status}`).slice(0, 200), {
      status: response.status, code: payload.code
    });
  }
  return payload.data || {};
}

function authorizeUrl({ appId, redirectUri, state, includeComments = true }) {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_key', appId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', [...DM_SCOPES, ...(includeComments ? COMMENT_SCOPES : [])].join(','));
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  return url.toString();
}

function tokenResult(data) {
  const now = Date.now();
  return {
    businessId: data.open_id ? String(data.open_id) : undefined,
    scope: data.scope || '',
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    accessExpiresAt: new Date(now + Number(data.expires_in || 0) * 1_000),
    refreshExpiresAt: new Date(now + Number(data.refresh_token_expires_in || 0) * 1_000)
  };
}

async function exchangeCode({ appId, appSecret, code, redirectUri }) {
  const data = await call('tt_user/oauth2/token/', {
    method: 'POST',
    body: { client_id: appId, client_secret: appSecret, grant_type: 'authorization_code', auth_code: code, redirect_uri: redirectUri }
  });
  return tokenResult(data);
}

async function refreshToken({ appId, appSecret, refreshToken: token }) {
  const data = await call('tt_user/oauth2/refresh_token/', {
    method: 'POST',
    body: { client_id: appId, client_secret: appSecret, grant_type: 'refresh_token', refresh_token: token }
  });
  return tokenResult(data);
}

async function businessProfile({ accessToken, businessId }) {
  const data = await call('business/get/', {
    accessToken,
    query: { business_id: businessId, fields: ['username', 'display_name'] }
  });
  return { username: data.username || null, displayName: data.display_name || null };
}

async function sendText({ accessToken, businessId, conversationId, text }) {
  const data = await call('business/message/send/', {
    method: 'POST',
    accessToken,
    body: {
      business_id: businessId,
      recipient_type: 'CONVERSATION',
      recipient: conversationId,
      message_type: 'TEXT',
      text: { body: text }
    }
  });
  return data.message?.message_id ? String(data.message.message_id) : null;
}

// Not idempotent: a retry posts a second public reply, so callers try once.
async function replyToComment({ accessToken, businessId, videoId, commentId, text }) {
  const data = await call('business/comment/reply/create/', {
    method: 'POST',
    accessToken,
    body: { business_id: businessId, video_id: videoId, comment_id: commentId, text }
  });
  return data.comment_id ? String(data.comment_id) : null;
}

// One subscription per event category; DIRECT_MESSAGE carries im_* events and
// COMMENT carries comment.update.
async function subscribeWebhook({ appId, appSecret, callbackUrl, eventType }) {
  await call('business/webhook/update/', {
    method: 'POST',
    body: { app_id: appId, secret: appSecret, event_type: eventType, callback_url: callbackUrl }
  });
}

async function listWebhook({ appId, appSecret, eventType }) {
  return call('business/webhook/list/', { query: { app_id: appId, secret: appSecret, event_type: eventType } });
}

module.exports = {
  TikTokApiError, DM_SCOPES, COMMENT_SCOPES, parseTikTokJson, authorizeUrl,
  exchangeCode, refreshToken, businessProfile, sendText, replyToComment, subscribeWebhook, listWebhook
};
