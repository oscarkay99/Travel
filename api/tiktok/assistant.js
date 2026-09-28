'use strict';

const crypto = require('crypto');
const tiktok = require('./client');
const { encrypt, decrypt } = require('./store');
const { answerUser } = require('../ai/agent');
const { redactSensitiveData, safeFallback } = require('../ai/guardrails');

const WHATSAPP = '+233 55 949 9248';
const DM_MAX_CHARS = 1_000;
const COMMENT_MAX_CHARS = 150;
const ECHO_DELAY_MS = 3_000;
const PENDING_MATCH_WINDOW_MS = 5 * 60_000;
const COMMENT_REPLY_COOLDOWN_MS = 24 * 60 * 60_000;
const DAILY_REPLIES_PER_CUSTOMER = 40;
const STATE_TTL_MS = 30 * 60_000;

const COMMENT_DM_INVITE = 'Great question! Send us a DM and an adviser will give you the full details.';
const COMMENT_LEAD_REPLY = 'Thanks! Our team will reach out. For your privacy, please DM us instead of posting your number publicly.';
const NON_TEXT_REPLY = `Thanks for reaching out! I can only read text messages here, so please type your question. You can also WhatsApp us on ${WHATSAPP}.`;

// Ghana numbers, or any international number written with a leading +.
const PHONE_PATTERN = /(?<!\d)(?:(?:\+?233|0)[ -]?(?:\d[ -]?){8}\d|\+[1-9](?:[ -]?\d){7,14})(?!\d)/;
const NAME_PATTERN = /\b(?:my name is|my name's|i am|i'm|this is|name\s*[:-])\s+([A-Za-z][A-Za-z'-]+(?:\s+[A-Za-z][A-Za-z'-]+){0,3})/i;
const NAME_STOPWORDS = new Set(['interested', 'looking', 'from', 'in', 'a', 'an', 'the', 'here', 'ok', 'okay', 'fine', 'good',
  'ready', 'not', 'just', 'also', 'still', 'very', 'so', 'and', 'my', 'i', 'is', 'phone', 'number', 'whatsapp', 'call',
  'calling', 'going', 'travelling', 'traveling', 'planning', 'want', 'wanting', 'need', 'currently', 'based', 'living', 'at', 'on', 'with']);

function config() {
  return {
    appId: process.env.TIKTOK_APP_ID || '',
    appSecret: process.env.TIKTOK_APP_SECRET || '',
    redirectUri: process.env.TIKTOK_REDIRECT_URI || 'https://rogernortconsult.com/api/tiktok/callback',
    webhookUrl: process.env.TIKTOK_WEBHOOK_URL || 'https://rogernortconsult.com/api/tiktok/webhook',
    repliesEnabled: process.env.TIKTOK_ASSISTANT_ENABLED !== 'false',
    commentsEnabled: process.env.TIKTOK_COMMENTS_ENABLED !== 'false'
  };
}

function isConfigured() {
  const { appId, appSecret } = config();
  return Boolean(appId && appSecret);
}

// ── Webhook authenticity ─────────────────────────────────────────────────────

// Header format: "t=<unix seconds>,s=<hex HMAC-SHA256(secret, `${t}.${body}`)>".
// Replays inside the window are absorbed by message/comment id de-duplication.
function verifySignature(header, rawBody, secret, { nowSeconds = Math.floor(Date.now() / 1_000), windowSeconds = 300 } = {}) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(String(header).split(',').map((part) => {
    const index = part.indexOf('=');
    return index > 0 ? [part.slice(0, index).trim(), part.slice(index + 1).trim()] : [part.trim(), ''];
  }));
  const timestamp = Number(parts.t);
  if (!Number.isInteger(timestamp) || !/^[0-9a-f]{64}$/i.test(parts.s || '')) return false;
  if (nowSeconds - timestamp > windowSeconds || timestamp - nowSeconds > 5) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest();
  const received = Buffer.from(parts.s, 'hex');
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

// ── OAuth state (only the CLI on the server can mint a valid connect link) ──

function stateKey(secret) {
  return Buffer.from(crypto.hkdfSync('sha256', secret, 'rogernort-tiktok', 'oauth-state-v1', 32));
}

function createState(secret, now = Date.now()) {
  const payload = `${now + STATE_TTL_MS}.${crypto.randomBytes(12).toString('hex')}`;
  const signature = crypto.createHmac('sha256', stateKey(secret)).update(payload).digest('hex');
  return `${payload}.${signature}`;
}

function verifyState(state, secret, now = Date.now()) {
  const match = /^(\d{13})\.([0-9a-f]{24})\.([0-9a-f]{64})$/.exec(String(state || ''));
  if (!match || !secret) return false;
  const expected = crypto.createHmac('sha256', stateKey(secret)).update(`${match[1]}.${match[2]}`).digest();
  const received = Buffer.from(match[3], 'hex');
  return crypto.timingSafeEqual(received, expected) && Number(match[1]) > now;
}

// ── Text helpers ─────────────────────────────────────────────────────────────

function toPlainText(markdown) {
  return String(markdown || '')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '$1 ($2)')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[*•]\s+/gm, '- ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function truncate(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '), cut.lastIndexOf('\n'));
  if (sentence > max * 0.5) return cut.slice(0, sentence + 1).trim();
  return `${cut.slice(0, cut.lastIndexOf(' ') > 0 ? cut.lastIndexOf(' ') : cut.length).trim()}…`;
}

function extractPhone(text) {
  const match = PHONE_PATTERN.exec(String(text || ''));
  return match ? match[0].replace(/[ -]/g, '') : null;
}

function extractName(text) {
  const match = NAME_PATTERN.exec(String(text || ''));
  if (!match) return null;
  const words = [];
  for (const word of match[1].split(/\s+/)) {
    if (NAME_STOPWORDS.has(word.toLowerCase())) break;
    words.push(word);
  }
  return words.length ? words.join(' ').slice(0, 80) : null;
}

// The shared redaction covers Ghana numbers; international ones are added here
// so no raw phone number is stored with the conversation or sent to the model.
function redact(text) {
  const safe = redactSensitiveData(text);
  const global = new RegExp(PHONE_PATTERN.source, 'g');
  if (!global.test(safe.text)) return safe;
  return {
    text: safe.text.replace(global, '[REDACTED phone number]'),
    redactions: [...new Set([...safe.redactions, 'phone number'])]
  };
}

function isLowSignalComment(text) {
  const letters = String(text || '').replace(/[^\p{L}\p{N}]/gu, '');
  return letters.length < 3;
}

// ── The assistant ────────────────────────────────────────────────────────────

function createTikTokAssistant({ store, saveLead, notifyLead, log = () => {}, api = tiktok, answer = answerUser, echoDelayMs = ECHO_DELAY_MS }) {
  const queues = new Map();
  const replyCounts = new Map();
  let cachedAccount = null;
  let refreshing = null;

  // Serialise work per conversation so two quick messages cannot race.
  function enqueue(key, task) {
    const previous = queues.get(key) || Promise.resolve();
    const next = previous.then(task, task).catch((error) => log('tiktok_task_failed', { error: error.message }));
    queues.set(key, next);
    next.finally(() => { if (queues.get(key) === next) queues.delete(key); });
    return next;
  }

  function withinDailyLimit(customerKey) {
    const day = new Date().toISOString().slice(0, 10);
    const entry = replyCounts.get(customerKey);
    if (!entry || entry.day !== day) {
      replyCounts.set(customerKey, { day, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= DAILY_REPLIES_PER_CUSTOMER;
  }

  async function accessToken() {
    const { appId, appSecret } = config();
    if (!cachedAccount) cachedAccount = await store.getAccount();
    if (!cachedAccount) throw new Error('No TikTok account is connected.');
    if (new Date(cachedAccount.access_expires_at).getTime() - Date.now() > 5 * 60_000) {
      return { token: decrypt(cachedAccount.access_token_enc, appSecret), businessId: cachedAccount.business_id };
    }
    if (!refreshing) {
      refreshing = (async () => {
        const refreshed = await api.refreshToken({ appId, appSecret, refreshToken: decrypt(cachedAccount.refresh_token_enc, appSecret) });
        const row = {
          business_id: cachedAccount.business_id,
          username: cachedAccount.username,
          access_token_enc: encrypt(refreshed.accessToken, appSecret),
          refresh_token_enc: encrypt(refreshed.refreshToken, appSecret),
          access_expires_at: refreshed.accessExpiresAt.toISOString(),
          refresh_expires_at: refreshed.refreshExpiresAt.toISOString(),
          scope: refreshed.scope || cachedAccount.scope
        };
        await store.saveAccount(row);
        cachedAccount = row;
      })().finally(() => { refreshing = null; });
    }
    await refreshing;
    return { token: decrypt(cachedAccount.access_token_enc, appSecret), businessId: cachedAccount.business_id };
  }

  async function connectAccount(code) {
    const { appId, appSecret, redirectUri } = config();
    const tokens = await api.exchangeCode({ appId, appSecret, code, redirectUri });
    if (!tokens.businessId || !tokens.accessToken || !tokens.refreshToken) throw new Error('TikTok returned an incomplete token.');
    let username = null;
    try { username = (await api.businessProfile({ accessToken: tokens.accessToken, businessId: tokens.businessId })).username; }
    catch (_) { log('tiktok_profile_lookup_failed', {}); }
    const row = {
      business_id: tokens.businessId,
      username,
      access_token_enc: encrypt(tokens.accessToken, appSecret),
      refresh_token_enc: encrypt(tokens.refreshToken, appSecret),
      access_expires_at: tokens.accessExpiresAt.toISOString(),
      refresh_expires_at: tokens.refreshExpiresAt.toISOString(),
      scope: tokens.scope
    };
    await store.saveAccount(row);
    cachedAccount = row;
    return { businessId: row.business_id, username, scope: row.scope };
  }

  async function captureLead({ phone, name, summary, origin }) {
    const lead = { name: name || 'TikTok client', phone, interest: `TikTok ${origin}`, summary, origin: 'TikTok' };
    let saved = false;
    try { await saveLead(lead); saved = true; }
    catch (_) { log('tiktok_lead_save_failed', {}); }
    let notified = false;
    try { await notifyLead(lead); notified = true; }
    catch (_) { log('tiktok_lead_email_failed', {}); }
    return saved || notified;
  }

  async function sendAssistantDm({ conversationId, text, provider, model }) {
    const conversation = await store.getConversation(conversationId);
    // A person may have replied while the model was thinking.
    if (conversation?.human_takeover) return false;
    const { token, businessId } = await accessToken();
    const pending = await store.insertPendingAssistantMessage({ conversation_id: conversationId, body: text, provider, model });
    const messageId = await api.sendText({ accessToken: token, businessId, conversationId, text });
    if (messageId && pending?.id) await store.setMessageId(pending.id, messageId);
    return true;
  }

  async function handleIncomingDm(businessId, content) {
    const conversationId = String(content.conversation_id);
    const messageId = content.message_id ? String(content.message_id) : null;
    const rawText = content.type === 'text' ? String(content.text?.body || '') : '';
    const safe = redact(rawText);
    const customerName = content.from ? String(content.from).slice(0, 80) : null;

    await store.ensureConversation({
      conversationId, businessId, customerId: content.from_user?.id ? String(content.from_user.id) : null, customerName
    });
    const conversation = await store.getConversation(conversationId);
    const history = await store.recentMessages(conversationId);
    const fresh = await store.insertMessage({
      conversation_id: conversationId, message_id: messageId, sender: 'customer',
      body: safe.text || `[${content.type || 'unsupported'} message]`, redactions: safe.redactions
    });
    if (!fresh) return; // Webhook retry of a message already handled.
    await store.updateConversation(conversationId, { last_customer_message_at: new Date().toISOString() });

    if (conversation?.human_takeover) return;
    if (!config().repliesEnabled) return;
    if (!withinDailyLimit(`dm:${conversationId}`)) {
      log('tiktok_daily_limit', { conversation: conversationId.slice(0, 12) });
      return;
    }

    if (!rawText.trim()) {
      return sendAssistantDm({ conversationId, text: NON_TEXT_REPLY, provider: 'non_text', model: null });
    }

    const phone = extractPhone(rawText);
    if (phone) {
      const alreadyCaptured = conversation?.lead_captured_at &&
        Date.now() - new Date(conversation.lead_captured_at).getTime() < 24 * 60 * 60_000;
      const name = extractName(rawText) || history.map((item) => item.sender === 'customer' && extractName(item.body)).find(Boolean) || customerName;
      let reply;
      if (alreadyCaptured) {
        reply = 'Thank you! Our adviser already has your details and will be in touch shortly. Is there anything else I can help with meanwhile?';
      } else {
        const transcript = [...history.filter((item) => item.sender === 'customer').map((item) => item.body), safe.text]
          .slice(-8).map((line) => `- ${line}`).join('\n');
        const ok = await captureLead({
          phone, name, origin: 'DM',
          summary: `TikTok DM from @${customerName || 'unknown'}\nRecent messages (sensitive details removed):\n${transcript}`
        });
        if (ok) {
          await store.updateConversation(conversationId, { lead_captured_at: new Date().toISOString() });
          reply = `Thank you${name && name !== customerName ? `, ${name.split(' ')[0]}` : ''}! I've passed your details to our team and an adviser will contact you shortly. Meanwhile, feel free to ask me anything else.`;
        } else {
          reply = `Sorry, I couldn't pass your details to the team just now. Please WhatsApp us on ${WHATSAPP} and an adviser will help you.`;
        }
      }
      return sendAssistantDm({ conversationId, text: reply, provider: 'lead_capture', model: null });
    }

    const result = await answer({
      channel: 'tiktok_dm',
      message: rawText.slice(0, 4_000),
      history: history
        .filter((item) => item.sender !== 'human')
        .map((item) => ({ role: item.sender === 'customer' ? 'user' : 'assistant', content: item.body }))
    });
    const text = truncate(toPlainText(result.text), DM_MAX_CHARS) || toPlainText(safeFallback());
    return sendAssistantDm({ conversationId, text, provider: result.provider, model: result.model });
  }

  // TikTok echoes every business-sent message, including ones typed by staff in
  // the TikTok app. Anything the assistant did not send means a human is in.
  async function handleOutgoingDm(businessId, content) {
    const conversationId = String(content.conversation_id);
    const messageId = content.message_id ? String(content.message_id) : null;
    const text = content.type === 'text' ? String(content.text?.body || '') : '';

    if (messageId && await store.findMessage(messageId)) return;
    const since = new Date(Date.now() - PENDING_MATCH_WINDOW_MS).toISOString();
    if (messageId && text && await store.claimPendingAssistantMessage(conversationId, text, messageId, since)) return;

    await store.ensureConversation({
      conversationId, businessId, customerId: content.to_user?.id ? String(content.to_user.id) : null, customerName: content.to || null
    });
    const safe = redact(text);
    await store.insertMessage({
      conversation_id: conversationId, message_id: messageId, sender: 'human',
      body: safe.text || `[${content.type || 'unsupported'} message]`, redactions: safe.redactions
    });
    await store.markHumanTakeover(conversationId);
    log('tiktok_human_takeover', { conversation: conversationId.slice(0, 12) });
  }

  async function handleComment(businessId, content) {
    const { commentsEnabled, repliesEnabled } = config();
    if (content.comment_action !== 'insert' || !content.comment_id || !content.video_id) return;
    const commentId = String(content.comment_id);
    const videoId = String(content.video_id);
    const commenterId = content.unique_identifier ? String(content.unique_identifier) : null;
    const parentId = content.parent_comment_id ? String(content.parent_comment_id) : '';
    const isReply = content.comment_type ? content.comment_type === 'reply' : Boolean(parentId && parentId !== '0');
    const rawText = String(content.text || '');
    const safe = redact(rawText);

    // Own comments, and every reply thread, are left to people. Rogernort's
    // own reply creates a comment event too, so this also prevents loops.
    if (!commenterId || commenterId === businessId || isReply) return;
    if (!(await store.claimComment({ comment_id: commentId, video_id: videoId, commenter_id: commenterId, body: safe.text }))) return;

    const skip = (reason) => store.updateComment(commentId, { outcome: 'skipped', skip_reason: reason });
    if (!commentsEnabled || !repliesEnabled) return skip('disabled');
    if (isLowSignalComment(rawText)) return skip('low_signal');
    const since = new Date(Date.now() - COMMENT_REPLY_COOLDOWN_MS).toISOString();
    if (await store.recentReplyToCommenter(commenterId, videoId, since)) return skip('already_replied_recently');

    let reply;
    let leadCaptured = false;
    const phone = extractPhone(rawText);
    if (phone) {
      leadCaptured = await captureLead({
        phone, name: extractName(rawText), origin: 'comment',
        summary: `Public TikTok comment on video ${videoId} (sensitive details removed):\n- ${safe.text}`
      });
      reply = leadCaptured ? COMMENT_LEAD_REPLY : `Thanks! Please DM us or WhatsApp ${WHATSAPP} and an adviser will help.`;
    } else {
      const result = await answer({ channel: 'tiktok_comment', message: rawText.slice(0, 4_000), history: [] });
      const text = toPlainText(result.text).replace(/\s+/g, ' ').trim();
      if (/^skip\.?$/i.test(text)) return skip('model_skipped');
      // Long rule-based answers belong in a DM, not a public comment.
      const usable = text && text.length <= COMMENT_MAX_CHARS && (result.provider === 'callback_form' || !result.handoffRecommended);
      reply = usable ? text : COMMENT_DM_INVITE;
    }

    try {
      const { token } = await accessToken();
      const replyId = await api.replyToComment({ accessToken: token, businessId, videoId, commentId, text: truncate(reply, COMMENT_MAX_CHARS) });
      await store.updateComment(commentId, { outcome: 'replied', reply_comment_id: replyId, reply_text: reply, lead_captured: leadCaptured });
    } catch (error) {
      await store.updateComment(commentId, { outcome: 'failed', skip_reason: String(error.message).slice(0, 200), lead_captured: leadCaptured });
      throw error;
    }
  }

  // `event` is the parsed webhook envelope. Resolves once handling is done.
  function handleEvent(event) {
    const businessId = String(event.user_openid || '');
    let content;
    try { content = typeof event.content === 'string' ? tiktok.parseTikTokJson(event.content) : event.content || {}; }
    catch (_) {
      log('tiktok_unparseable_event', { event: String(event.event).slice(0, 40) });
      return Promise.resolve();
    }

    switch (event.event) {
      case 'im_receive_msg': {
        if (!content.conversation_id) return Promise.resolve();
        // Messages from the business itself arrive as im_send_msg; guard anyway.
        if (content.from_user?.id && String(content.from_user.id) === businessId) return Promise.resolve();
        return enqueue(`dm:${content.conversation_id}`, () => handleIncomingDm(businessId, content));
      }
      case 'im_send_msg': {
        if (!content.conversation_id) return Promise.resolve();
        // Let the send call that produced this echo record its message id first.
        return new Promise((resolve) => setTimeout(resolve, echoDelayMs).unref?.())
          .then(() => enqueue(`dm:${content.conversation_id}`, () => handleOutgoingDm(businessId, content)));
      }
      case 'comment.update':
        return enqueue(`comment:${content.comment_id}`, () => handleComment(businessId, content));
      case 'authorization.removed':
        cachedAccount = null;
        log('tiktok_authorization_removed', {});
        return Promise.resolve();
      default:
        return Promise.resolve();
    }
  }

  return { handleEvent, connectAccount, accessToken };
}

module.exports = {
  createTikTokAssistant, config, isConfigured, verifySignature, createState, verifyState,
  toPlainText, truncate, extractPhone, extractName, redact, isLowSignalComment
};
