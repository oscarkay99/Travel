'use strict';

// Operator commands, run inside the API container on the VPS:
//   docker exec rogernort-api node tiktok/cli.js connect-url [--dm-only]
//   docker exec rogernort-api node tiktok/cli.js subscribe [--dm-only]
//   docker exec rogernort-api node tiktok/cli.js status

const tiktok = require('./client');
const assistant = require('./assistant');

async function main([command, ...flags]) {
  if (!assistant.isConfigured()) throw new Error('TIKTOK_APP_ID and TIKTOK_APP_SECRET must be set.');
  const { appId, appSecret, redirectUri, webhookUrl } = assistant.config();
  const dmOnly = flags.includes('--dm-only');

  if (command === 'connect-url') {
    const url = tiktok.authorizeUrl({ appId, redirectUri, state: assistant.createState(appSecret), includeComments: !dmOnly });
    console.log('Open this link while logged in to the Rogernort TikTok account (valid for 30 minutes):\n');
    console.log(url);
    return;
  }

  if (command === 'subscribe') {
    const eventTypes = dmOnly ? ['DIRECT_MESSAGE'] : ['DIRECT_MESSAGE', 'COMMENT'];
    for (const eventType of eventTypes) {
      try {
        await tiktok.subscribeWebhook({ appId, appSecret, callbackUrl: webhookUrl, eventType });
        console.log(`Subscribed ${eventType} -> ${webhookUrl}`);
      } catch (error) {
        console.log(`Could not subscribe ${eventType}: ${error.message}`);
        process.exitCode = 1;
      }
    }
    return;
  }

  if (command === 'status') {
    const { supaRequest } = require('../server');
    const { createStore } = require('./store');
    const account = await createStore(supaRequest).getAccount();
    if (!account) console.log('No TikTok account connected yet. Run: node tiktok/cli.js connect-url');
    else {
      console.log(`Connected: @${account.username || 'unknown'} (business id ${account.business_id})`);
      console.log(`Scopes: ${account.scope || 'unknown'}`);
      console.log(`Access token expires: ${account.access_expires_at} (refreshed automatically)`);
      console.log(`Refresh token expires: ${account.refresh_expires_at} (reconnect before this date)`);
    }
    for (const eventType of ['DIRECT_MESSAGE', 'COMMENT']) {
      try {
        const data = await tiktok.listWebhook({ appId, appSecret, eventType });
        console.log(`Webhook ${eventType}: ${data.callback_url || JSON.stringify(data)}`);
      } catch (error) {
        console.log(`Webhook ${eventType}: not registered (${error.message})`);
      }
    }
    return;
  }

  console.log('Usage: node tiktok/cli.js <connect-url|subscribe|status> [--dm-only]');
  process.exitCode = 1;
}

main(process.argv.slice(2)).then(() => process.exit(process.exitCode || 0)).catch((error) => {
  console.error(error.message);
  process.exit(1);
});
