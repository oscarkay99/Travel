# Rogernort TikTok assistant

Answers TikTok direct messages and video comments for `@rogernort.travelandtour`
with the same Gemini-backed adviser as the website (`api/ai/`).

- **DMs:** replies in plain text. If the client sends a phone number, the
  assistant saves a lead (`rogernort.leads`, source `tiktok`) and emails the team.
  The number is never sent to the model or stored with the conversation.
- **Comments:** replies once, publicly, to top-level comments that need an
  answer. It never replies inside reply threads, never repeats personal details
  in public, and replies to a person at most once per video per day.
- **Human takeover:** TikTok sends an `im_send_msg` event for every message the
  business sends, including ones typed in the TikTok app. Any outgoing message
  the assistant did not send sets `tiktok_conversations.human_takeover`, and the
  assistant never replies in that conversation again. To hand a conversation
  back, clear that flag in the database.

Comment-to-DM (TikTok's `direct_reply`) is only available to accounts
registered in Vietnam, Indonesia and Thailand, so it is not used here.

## TikTok developer portal settings

| Setting | Value |
| --- | --- |
| Redirect URI | `https://rogernortconsult.com/api/tiktok/callback` |
| Webhook callback URL | `https://rogernortconsult.com/api/tiktok/webhook` |
| DM scopes | `user.info.basic`, `user.info.username`, `message.list.read`, `message.list.send`, `message.list.manage` |
| Comment scopes | `comment.list`, `comment.list.manage` |

## Going live

1. Add the app credentials as GitHub Actions secrets:
   ```sh
   gh secret set TIKTOK_APP_ID
   gh secret set TIKTOK_APP_SECRET
   ```
2. Re-run the deploy workflow (or push to `main`) so the API picks them up.
3. On the VPS, create a connect link and open it while logged in to the
   Rogernort TikTok account. Add `--dm-only` if the comment scopes are not
   approved yet, because TikTok rejects the whole link over one unapproved scope.
   ```sh
   docker exec rogernort-api node tiktok/cli.js connect-url
   ```
4. Register the webhooks, then confirm:
   ```sh
   docker exec rogernort-api node tiktok/cli.js subscribe
   docker exec rogernort-api node tiktok/cli.js status
   ```

Access tokens refresh automatically. `status` shows when the refresh token
expires; reconnect with a new link before then.

## Switches

Environment variables on the API container:

- `TIKTOK_ASSISTANT_ENABLED=false` stops all automatic replies. Messages are still recorded.
- `TIKTOK_COMMENTS_ENABLED=false` stops comment replies only.
