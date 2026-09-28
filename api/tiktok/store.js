'use strict';

const crypto = require('crypto');

// Persistence for the TikTok assistant over PostgREST. `request` is the API's
// service-role database client: (method, route, body, options) => Promise.

function tokenKey(appSecret) {
  if (!appSecret) throw new Error('TikTok app secret is not configured.');
  return Buffer.from(crypto.hkdfSync('sha256', appSecret, 'rogernort-tiktok', 'token-encryption-v1', 32));
}

function encrypt(value, appSecret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', tokenKey(appSecret), iv);
  const data = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join('.');
}

function decrypt(value, appSecret) {
  const [version, iv, tag, data] = String(value).split('.');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('Stored TikTok token is malformed.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', tokenKey(appSecret), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

function bodyHash(text) {
  return crypto.createHash('sha256').update(String(text).trim()).digest('hex');
}

const eq = (value) => `eq.${encodeURIComponent(value)}`;

function createStore(request) {
  const first = (rows) => (Array.isArray(rows) ? rows[0] || null : rows || null);
  const upsert = (table, row, conflict) => request('POST', `/rest/v1/${table}?on_conflict=${conflict}`, row, {
    prefer: 'resolution=merge-duplicates,return=minimal'
  });

  return {
    async getAccount() {
      return first(await request('GET', '/rest/v1/tiktok_accounts?select=*&order=updated_at.desc&limit=1', undefined, { prefer: null }));
    },

    async saveAccount(row) {
      await upsert('tiktok_accounts', { ...row, updated_at: new Date().toISOString() }, 'business_id');
    },

    async getConversation(conversationId) {
      return first(await request('GET',
        `/rest/v1/tiktok_conversations?select=*&conversation_id=${eq(conversationId)}&limit=1`, undefined, { prefer: null }));
    },

    // Creates the row if missing without overwriting takeover or lead state.
    async ensureConversation({ conversationId, businessId, customerId, customerName }) {
      await request('POST', '/rest/v1/tiktok_conversations?on_conflict=conversation_id', {
        conversation_id: conversationId, business_id: businessId,
        customer_id: customerId || null, customer_name: customerName || null
      }, { prefer: 'resolution=ignore-duplicates,return=minimal' });
    },

    async updateConversation(conversationId, fields) {
      await request('PATCH', `/rest/v1/tiktok_conversations?conversation_id=${eq(conversationId)}`,
        { ...fields, updated_at: new Date().toISOString() });
    },

    async markHumanTakeover(conversationId) {
      const at = new Date().toISOString();
      await request('PATCH',
        `/rest/v1/tiktok_conversations?conversation_id=${eq(conversationId)}&human_takeover=eq.false`,
        { human_takeover: true, human_takeover_at: at, updated_at: at });
    },

    // Returns false when the message id was already recorded (webhook retry).
    async insertMessage(row) {
      const rows = await request('POST', '/rest/v1/tiktok_messages?on_conflict=message_id', {
        ...row, body_hash: row.body_hash || bodyHash(row.body || '')
      }, { prefer: 'resolution=ignore-duplicates,return=representation' });
      return Array.isArray(rows) ? rows.length > 0 : Boolean(rows);
    },

    async findMessage(messageId) {
      return first(await request('GET',
        `/rest/v1/tiktok_messages?select=id,sender,conversation_id&message_id=${eq(messageId)}&limit=1`, undefined, { prefer: null }));
    },

    // An assistant send recorded before TikTok returned its message id.
    async claimPendingAssistantMessage(conversationId, text, messageId, sinceIso) {
      const rows = await request('GET',
        `/rest/v1/tiktok_messages?select=id&conversation_id=${eq(conversationId)}&sender=eq.assistant` +
        `&message_id=is.null&body_hash=eq.${bodyHash(text)}&created_at=gte.${encodeURIComponent(sinceIso)}&order=created_at.asc&limit=1`,
        undefined, { prefer: null });
      const row = first(rows);
      if (!row) return false;
      await request('PATCH', `/rest/v1/tiktok_messages?id=eq.${Number(row.id)}`, { message_id: messageId });
      return true;
    },

    async setMessageId(rowId, messageId) {
      await request('PATCH', `/rest/v1/tiktok_messages?id=eq.${Number(rowId)}`, { message_id: messageId });
    },

    async insertPendingAssistantMessage(row) {
      const rows = await request('POST', '/rest/v1/tiktok_messages', {
        ...row, sender: 'assistant', message_id: null, body_hash: bodyHash(row.body)
      }, { prefer: 'return=representation' });
      return first(rows);
    },

    async recentMessages(conversationId, limit = 16) {
      const rows = await request('GET',
        `/rest/v1/tiktok_messages?select=sender,body,created_at&conversation_id=${eq(conversationId)}` +
        `&order=created_at.desc&limit=${Number(limit)}`, undefined, { prefer: null });
      return (Array.isArray(rows) ? rows : []).reverse();
    },

    // Returns false when the comment was already seen (webhook retry).
    async claimComment(row) {
      const rows = await request('POST', '/rest/v1/tiktok_comments?on_conflict=comment_id', row, {
        prefer: 'resolution=ignore-duplicates,return=representation'
      });
      return Array.isArray(rows) ? rows.length > 0 : Boolean(rows);
    },

    async updateComment(commentId, fields) {
      await request('PATCH', `/rest/v1/tiktok_comments?comment_id=${eq(commentId)}`, fields);
    },

    async recentReplyToCommenter(commenterId, videoId, sinceIso) {
      const rows = await request('GET',
        `/rest/v1/tiktok_comments?select=comment_id&commenter_id=${eq(commenterId)}&video_id=${eq(videoId)}` +
        `&outcome=eq.replied&created_at=gte.${encodeURIComponent(sinceIso)}&limit=1`, undefined, { prefer: null });
      return Boolean(first(rows));
    }
  };
}

module.exports = { createStore, encrypt, decrypt, bodyHash };
