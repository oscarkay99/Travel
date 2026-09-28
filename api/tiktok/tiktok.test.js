'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

process.env.GEMINI_API_KEY_1 = process.env.GEMINI_API_KEY_1 || 'test-only-key';
process.env.GEMINI_MODELS = process.env.GEMINI_MODELS || 'test-model';
process.env.TIKTOK_APP_ID = 'test-app';
process.env.TIKTOK_APP_SECRET = 'test-secret';

const client = require('./client');
const assistant = require('./assistant');
const { encrypt, decrypt, bodyHash } = require('./store');

const realFetch = global.fetch;
const BUSINESS = 'biz-open-id';
const SECRET = 'test-secret';

// In-memory stand-in for ./store with the same method contract.
function memoryStore() {
  const account = {
    business_id: BUSINESS, username: 'rogernort.travelandtour', scope: 'message.list.send',
    access_token_enc: encrypt('access-1', SECRET), refresh_token_enc: encrypt('refresh-1', SECRET),
    access_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    refresh_expires_at: new Date(Date.now() + 86_400_000).toISOString()
  };
  const conversations = new Map();
  const messages = [];
  const comments = new Map();
  let nextId = 1;
  return {
    conversations, messages, comments, account,
    async getAccount() { return this.account; },
    async saveAccount(row) { this.account = row; },
    async getConversation(id) { return conversations.get(id) || null; },
    async ensureConversation({ conversationId, businessId, customerId, customerName }) {
      if (!conversations.has(conversationId)) {
        conversations.set(conversationId, {
          conversation_id: conversationId, business_id: businessId, customer_id: customerId,
          customer_name: customerName, human_takeover: false, lead_captured_at: null
        });
      }
    },
    async updateConversation(id, fields) { Object.assign(conversations.get(id), fields); },
    async markHumanTakeover(id) {
      const row = conversations.get(id);
      if (!row.human_takeover) Object.assign(row, { human_takeover: true, human_takeover_at: new Date().toISOString() });
    },
    async insertMessage(row) {
      if (row.message_id && messages.some((item) => item.message_id === row.message_id)) return false;
      messages.push({ id: nextId++, created_at: new Date().toISOString(), body_hash: bodyHash(row.body), ...row });
      return true;
    },
    async findMessage(messageId) { return messages.find((item) => item.message_id === messageId) || null; },
    async claimPendingAssistantMessage(conversationId, text, messageId) {
      const row = messages.find((item) => item.conversation_id === conversationId && item.sender === 'assistant' &&
        !item.message_id && item.body_hash === bodyHash(text));
      if (!row) return false;
      row.message_id = messageId;
      return true;
    },
    async setMessageId(rowId, messageId) { messages.find((item) => item.id === rowId).message_id = messageId; },
    async insertPendingAssistantMessage(row) {
      const stored = { id: nextId++, created_at: new Date().toISOString(), ...row, sender: 'assistant', message_id: null, body_hash: bodyHash(row.body) };
      messages.push(stored);
      return stored;
    },
    async recentMessages(conversationId) {
      return messages.filter((item) => item.conversation_id === conversationId).map(({ sender, body }) => ({ sender, body }));
    },
    async claimComment(row) {
      if (comments.has(row.comment_id)) return false;
      comments.set(row.comment_id, { outcome: 'pending', created_at: new Date().toISOString(), ...row });
      return true;
    },
    async updateComment(id, fields) { Object.assign(comments.get(id), fields); },
    async recentReplyToCommenter(commenterId, videoId) {
      return [...comments.values()].some((item) => item.commenter_id === commenterId && item.video_id === videoId && item.outcome === 'replied');
    }
  };
}

function harness({ answerText = 'Hello from **Rogernort**', answerProvider = 'gemini_project_1', sendReturnsId = true } = {}) {
  const store = memoryStore();
  const sent = [];
  const commentReplies = [];
  const leads = [];
  const emails = [];
  const answers = [];
  let messageCounter = 100;
  const api = {
    ...client,
    async sendText(args) {
      sent.push(args);
      return sendReturnsId ? String(messageCounter++) : null;
    },
    async replyToComment(args) { commentReplies.push(args); return 'reply-1'; },
    async refreshToken() {
      return {
        accessToken: 'access-2', refreshToken: 'refresh-2', scope: 'message.list.send',
        accessExpiresAt: new Date(Date.now() + 86_400_000), refreshExpiresAt: new Date(Date.now() + 365 * 86_400_000)
      };
    }
  };
  const answer = async (input) => {
    answers.push(input);
    return { text: typeof answerText === 'function' ? answerText(input) : answerText, provider: answerProvider, model: 'test-model', handoffRecommended: false };
  };
  const bot = assistant.createTikTokAssistant({
    store, api, answer, echoDelayMs: 0,
    saveLead: async (lead) => { leads.push(lead); },
    notifyLead: async (lead) => { emails.push(lead); }
  });
  return { bot, store, sent, commentReplies, leads, emails, answers };
}

function dmEvent(kind, { conversationId = 'conv-1', messageId, text, from = 'kofi_travels', type = 'text' }) {
  const incoming = kind === 'im_receive_msg';
  return {
    client_key: 'test-app', event: kind, create_time: Math.floor(Date.now() / 1_000), user_openid: BUSINESS,
    content: JSON.stringify({
      conversation_id: conversationId, message_id: messageId, type, timestamp: Date.now(),
      ...(type === 'text' ? { text: { body: text } } : {}),
      from: incoming ? from : 'rogernort.travelandtour', to: incoming ? 'rogernort.travelandtour' : from,
      from_user: { id: incoming ? 'customer-1' : BUSINESS }, to_user: { id: incoming ? BUSINESS : 'customer-1' }
    })
  };
}

function commentEvent({ commentId = '7247303576418566913', text, commenter = 'fan-1', parent = 0, type = 'comment', action = 'insert' }) {
  // Written by hand so the snowflake ids arrive as bare JSON numbers, as TikTok sends them.
  return {
    client_key: 'test-app', event: 'comment.update', create_time: Math.floor(Date.now() / 1_000), user_openid: BUSINESS,
    content: `{"comment_id":${commentId},"video_id":7247303576418560001,"parent_comment_id":${parent},"comment_type":"${type}","comment_action":"${action}","unique_identifier":"${commenter}","text":${JSON.stringify(text)},"timestamp":${Date.now()}}`
  };
}

describe('TikTok assistant', { concurrency: false }, () => {
  test('verifies webhook signatures and rejects tampering or stale timestamps', () => {
    const body = '{"event":"im_receive_msg"}';
    const now = 1_800_000_000;
    const signature = crypto.createHmac('sha256', SECRET).update(`${now}.${body}`).digest('hex');
    assert.equal(assistant.verifySignature(`t=${now},s=${signature}`, body, SECRET, { nowSeconds: now }), true);
    assert.equal(assistant.verifySignature(`t=${now},s=${signature}`, `${body} `, SECRET, { nowSeconds: now }), false);
    assert.equal(assistant.verifySignature(`t=${now},s=${signature}`, body, 'other-secret', { nowSeconds: now }), false);
    assert.equal(assistant.verifySignature(`t=${now},s=${signature}`, body, SECRET, { nowSeconds: now + 301 }), false);
    assert.equal(assistant.verifySignature('', body, SECRET), false);
    assert.equal(assistant.verifySignature('t=abc,s=zz', body, SECRET), false);
  });

  test('keeps 19-digit TikTok ids exact when parsing', () => {
    const parsed = client.parseTikTokJson('{"comment_id":7247303576418566913,"timestamp":1727500000000,"ids":[7247303576418566914]}');
    assert.equal(parsed.comment_id, '7247303576418566913');
    assert.equal(parsed.timestamp, 1727500000000);
    assert.deepEqual(parsed.ids, ['7247303576418566914']);
    const text = client.parseTikTokJson('{"text":{"body":"ref :1234567890123456, thanks"}}');
    assert.equal(text.text.body, 'ref :1234567890123456, thanks');
  });

  test('connect links are signed, single-purpose and expire', () => {
    const state = assistant.createState(SECRET, Date.now());
    assert.equal(assistant.verifyState(state, SECRET), true);
    assert.equal(assistant.verifyState(state, 'other-secret'), false);
    assert.equal(assistant.verifyState(state.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a')), SECRET), false);
    assert.equal(assistant.verifyState(assistant.createState(SECRET, Date.now() - 31 * 60_000), SECRET), false);
    assert.equal(assistant.verifyState('garbage', SECRET), false);
  });

  test('stored tokens are encrypted and round-trip', () => {
    const sealed = encrypt('secret-token', SECRET);
    assert.doesNotMatch(sealed, /secret-token/);
    assert.equal(decrypt(sealed, SECRET), 'secret-token');
    assert.throws(() => decrypt(sealed, 'wrong-secret'));
  });

  test('answers a DM in plain text using the TikTok DM channel', async () => {
    const { bot, sent, answers, store } = harness();
    await bot.handleEvent(dmEvent('im_receive_msg', { messageId: 'm1', text: 'Do you do Dubai packages?' }));
    assert.equal(answers[0].channel, 'tiktok_dm');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].text, 'Hello from Rogernort');
    assert.equal(sent[0].conversationId, 'conv-1');
    assert.equal(sent[0].accessToken, 'access-1');
    const assistantRow = store.messages.find((item) => item.sender === 'assistant');
    assert.equal(assistantRow.message_id, '100');
  });

  test('ignores the echo of its own reply and keeps answering', async () => {
    const { bot, sent, store } = harness();
    await bot.handleEvent(dmEvent('im_receive_msg', { messageId: 'm1', text: 'Hi' }));
    await bot.handleEvent(dmEvent('im_send_msg', { messageId: '100', text: 'Hello from Rogernort' }));
    assert.equal(store.conversations.get('conv-1').human_takeover, false);
    await bot.handleEvent(dmEvent('im_receive_msg', { messageId: 'm2', text: 'Thanks' }));
    assert.equal(sent.length, 2);
  });

  test('recognises its own reply by content when TikTok returns no message id', async () => {
    const { bot, store } = harness({ sendReturnsId: false });
    await bot.handleEvent(dmEvent('im_receive_msg', { messageId: 'm1', text: 'Hi' }));
    await bot.handleEvent(dmEvent('im_send_msg', { messageId: 'echo-1', text: 'Hello from Rogernort' }));
    assert.equal(store.conversations.get('conv-1').human_takeover, false);
    assert.equal(store.messages.find((item) => item.sender === 'assistant').message_id, 'echo-1');
  });

  test('goes permanently silent once a person replies from the TikTok app', async () => {
    const { bot, sent, store } = harness();
    await bot.handleEvent(dmEvent('im_receive_msg', { messageId: 'm1', text: 'Hi' }));
    await bot.handleEvent(dmEvent('im_send_msg', { messageId: 'staff-1', text: 'Hi Kofi, this is Roger. Let me help you.' }));
    const conversation = store.conversations.get('conv-1');
    assert.equal(conversation.human_takeover, true);
    assert.ok(store.messages.some((item) => item.sender === 'human'));
    await bot.handleEvent(dmEvent('im_receive_msg', { messageId: 'm2', text: 'Great, what documents do I need?' }));
    await bot.handleEvent(dmEvent('im_receive_msg', { messageId: 'm3', text: 'Hello?' }));
    assert.equal(sent.length, 1);
    assert.equal(conversation.human_takeover, true);
  });

  test('does not send if a person took over while the reply was being written', async () => {
    const { bot, sent, store } = harness({
      answerText: () => {
        store.conversations.get('conv-1').human_takeover = true;
        return 'Too late';
      }
    });
    await bot.handleEvent(dmEvent('im_receive_msg', { messageId: 'm1', text: 'Hi' }));
    assert.equal(sent.length, 0);
  });

  test('a staff image or sticker also counts as a takeover', async () => {
    const { bot, store } = harness();
    await bot.handleEvent(dmEvent('im_receive_msg', { messageId: 'm1', text: 'Hi' }));
    await bot.handleEvent(dmEvent('im_send_msg', { messageId: 'staff-img', type: 'image' }));
    assert.equal(store.conversations.get('conv-1').human_takeover, true);
  });

  test('captures a lead from a DM without sending the number to the model', async () => {
    const { bot, sent, answers, leads, emails, store } = harness();
    await bot.handleEvent(dmEvent('im_receive_msg', { messageId: 'm1', text: 'I want to travel to Dubai in December' }));
    await bot.handleEvent(dmEvent('im_receive_msg', { messageId: 'm2', text: 'My name is Ama Owusu and my number is 024 412 3456' }));
    assert.equal(answers.length, 1);
    assert.equal(leads.length, 1);
    assert.equal(emails.length, 1);
    assert.equal(leads[0].phone, '0244123456');
    assert.equal(leads[0].name, 'Ama Owusu');
    assert.equal(leads[0].origin, 'TikTok');
    assert.match(leads[0].summary, /Dubai in December/);
    assert.doesNotMatch(leads[0].summary, /0244123456|024 412 3456/);
    assert.match(sent.at(-1).text, /Thank you, Ama! I've passed your details/);
    assert.ok(store.messages.every((item) => !/412 3456|4123456/.test(item.body)));
    assert.ok(store.conversations.get('conv-1').lead_captured_at);
  });

  test('redacts international numbers and does not duplicate a lead the same day', async () => {
    const { bot, leads, sent, store } = harness();
    await bot.handleEvent(dmEvent('im_receive_msg', { messageId: 'm1', text: 'Call me on +44 7911 123456' }));
    await bot.handleEvent(dmEvent('im_receive_msg', { messageId: 'm2', text: 'Or +44 7911 654321' }));
    assert.equal(leads.length, 1);
    assert.equal(leads[0].phone, '+447911123456');
    assert.match(sent.at(-1).text, /already has your details/);
    assert.ok(store.messages.every((item) => !/7911/.test(item.body)));
  });

  test('tells the client to use WhatsApp if the lead could not be passed on', async () => {
    const store = memoryStore();
    const sent = [];
    const bot = assistant.createTikTokAssistant({
      store, echoDelayMs: 0, answer: async () => ({ text: 'x', provider: 'p' }),
      api: { ...client, sendText: async (args) => { sent.push(args); return '1'; } },
      saveLead: async () => { throw new Error('db down'); },
      notifyLead: async () => { throw new Error('email down'); }
    });
    await bot.handleEvent(dmEvent('im_receive_msg', { messageId: 'm1', text: 'My number is 0244123456' }));
    assert.match(sent[0].text, /WhatsApp us on \+233 55 949 9248/);
    assert.equal(store.conversations.get('conv-1').lead_captured_at, null);
  });

  test('handles webhook retries of the same message once', async () => {
    const { bot, sent } = harness();
    const event = dmEvent('im_receive_msg', { messageId: 'm1', text: 'Hi' });
    await bot.handleEvent(event);
    await bot.handleEvent(event);
    assert.equal(sent.length, 1);
  });

  test('replies to non-text messages with a short prompt to type', async () => {
    const { bot, sent, answers } = harness();
    await bot.handleEvent(dmEvent('im_receive_msg', { messageId: 'm1', type: 'sticker' }));
    assert.equal(answers.length, 0);
    assert.match(sent[0].text, /only read text messages/);
  });

  test('refreshes an expiring access token before sending', async () => {
    const { bot, sent, store } = harness();
    store.account.access_expires_at = new Date(Date.now() + 60_000).toISOString();
    await bot.handleEvent(dmEvent('im_receive_msg', { messageId: 'm1', text: 'Hi' }));
    assert.equal(sent[0].accessToken, 'access-2');
    assert.equal(decrypt(store.account.refresh_token_enc, SECRET), 'refresh-2');
  });

  test('replies publicly to a top-level comment question with exact ids', async () => {
    const { bot, commentReplies, answers, store } = harness({ answerText: 'Yes! We help with Dubai visas. DM us for details.' });
    await bot.handleEvent(commentEvent({ text: 'Do you help with Dubai visa?' }));
    assert.equal(answers[0].channel, 'tiktok_comment');
    assert.equal(commentReplies.length, 1);
    assert.equal(commentReplies[0].commentId, '7247303576418566913');
    assert.equal(commentReplies[0].videoId, '7247303576418560001');
    assert.equal(store.comments.get('7247303576418566913').outcome, 'replied');
  });

  test('never replies inside reply threads, to its own comments, or twice to a retry', async () => {
    const { bot, commentReplies } = harness({ answerText: 'Sure!' });
    await bot.handleEvent(commentEvent({ commentId: '7247303576418566001', text: 'How much?', parent: '7247303576418566913', type: 'reply' }));
    await bot.handleEvent(commentEvent({ commentId: '7247303576418566002', text: 'Our new offer', commenter: BUSINESS }));
    const event = commentEvent({ commentId: '7247303576418566003', text: 'How do I apply?' });
    await bot.handleEvent(event);
    await bot.handleEvent(event);
    assert.equal(commentReplies.length, 1);
  });

  test('skips low-signal comments and ones the model marks SKIP', async () => {
    const { bot, commentReplies, store } = harness({ answerText: 'SKIP' });
    await bot.handleEvent(commentEvent({ commentId: '7247303576418566004', text: '🔥🔥' }));
    await bot.handleEvent(commentEvent({ commentId: '7247303576418566005', text: 'Love this video so much' }));
    assert.equal(commentReplies.length, 0);
    assert.equal(store.comments.get('7247303576418566004').skip_reason, 'low_signal');
    assert.equal(store.comments.get('7247303576418566005').skip_reason, 'model_skipped');
  });

  test('replies at most once per commenter per video per day', async () => {
    const { bot, commentReplies } = harness({ answerText: 'Happy to help, DM us!' });
    await bot.handleEvent(commentEvent({ commentId: '7247303576418566006', text: 'How do I apply?' }));
    await bot.handleEvent(commentEvent({ commentId: '7247303576418566007', text: 'Hello again, how do I apply?' }));
    assert.equal(commentReplies.length, 1);
  });

  test('moves long answers to DMs and never repeats a number in public', async () => {
    const { bot, commentReplies, leads } = harness({ answerText: 'x'.repeat(400) });
    await bot.handleEvent(commentEvent({ commentId: '7247303576418566008', text: 'What are the requirements for Poland?' }));
    await bot.handleEvent(commentEvent({ commentId: '7247303576418566009', text: 'Call me 0244123456', commenter: 'fan-2' }));
    assert.match(commentReplies[0].text, /Send us a DM/);
    assert.equal(leads.length, 1);
    assert.doesNotMatch(commentReplies[1].text, /0244/);
    assert.match(commentReplies[1].text, /please DM us instead of posting your number/);
    assert.ok(commentReplies.every((reply) => reply.text.length <= 150));
  });

  test('formats markdown for TikTok and trims long replies', () => {
    assert.equal(assistant.toPlainText('**Visa:** yes\n* one\n* two\n\n\n\n[Site](https://rogernortconsult.com)'),
      'Visa: yes\n- one\n- two\n\nSite (https://rogernortconsult.com)');
    const long = `${'Sentence one is here. '.repeat(60)}`;
    assert.ok(assistant.truncate(long, 1000).length <= 1000);
    assert.match(assistant.truncate(long, 1000), /\.$/);
  });

  test('extracts names without swallowing the rest of the sentence', () => {
    assert.equal(assistant.extractName("I'm Kwame and I want to go to Canada"), 'Kwame');
    assert.equal(assistant.extractName('I am interested in Dubai'), null);
    assert.equal(assistant.extractName('My name is Ama Owusu, 0244123456'), 'Ama Owusu');
  });
});

describe('TikTok channels in the shared agent', { concurrency: false }, () => {
  test('a callback request on TikTok asks for details in the DM', async () => {
    const { answerUser } = require('../ai/agent');
    const result = await answerUser({ channel: 'tiktok_dm', message: 'Can someone call me back?' });
    assert.equal(result.provider, 'callback_form');
    assert.match(result.text, /reply with your full name/);
    assert.doesNotMatch(result.text, /callback form below/);
  });

  test('the website channel is unchanged by default', async () => {
    const { answerUser } = require('../ai/agent');
    const result = await answerUser({ message: 'Can someone call me back?' });
    assert.match(result.text, /callback form below/);
  });

  test('TikTok prompts forbid markdown and cap comment length', async () => {
    let request;
    global.fetch = async (_url, options) => {
      request = JSON.parse(options.body);
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ candidates: [{ content: { parts: [{ text: 'SKIP' }] } }] }) };
    };
    const { answerUser } = require('../ai/agent');
    await answerUser({ channel: 'tiktok_comment', message: 'Nice video' });
    const prompt = request.systemInstruction.parts[0].text;
    assert.match(prompt, /PUBLIC reply/);
    assert.match(prompt, /at most 140 characters/);
    assert.match(prompt, /The Base, New-Legon, Adenta/);
    await assert.rejects(answerUser({ channel: 'instagram', message: 'hi' }), /Unknown assistant channel/);
    global.fetch = realFetch;
  });
});

describe('TikTok webhook route', { concurrency: false }, () => {
  test('rejects unsigned deliveries and acknowledges signed ones', async () => {
    const { server } = require('../server');
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
      const body = JSON.stringify({ event: 'unknown_event', user_openid: BUSINESS, content: '{}' });
      const unsigned = await fetch(`http://127.0.0.1:${port}/api/tiktok/webhook`, { method: 'POST', body, headers: { 'Content-Type': 'application/json' } });
      assert.equal(unsigned.status, 401);

      const t = Math.floor(Date.now() / 1_000);
      const s = crypto.createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex');
      const signed = await fetch(`http://127.0.0.1:${port}/api/tiktok/webhook`, {
        method: 'POST', body, headers: { 'Content-Type': 'application/json', 'TikTok-Signature': `t=${t},s=${s}` }
      });
      assert.equal(signed.status, 200);

      const badState = await fetch(`http://127.0.0.1:${port}/api/tiktok/callback?code=abc&state=forged`);
      assert.equal(badState.status, 400);
      assert.match(await badState.text(), /invalid or has expired/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
