# MoneyBag Access Worker

Gates `public/index.html` (a copy of `tools/moneybag-analyst.html`) behind
time-limited access tokens. No accounts — you generate a link per person via
the admin panel, they open it, get 24h of access, and after that see a
"please pay" page until you manually extend their token.

**Live URL:** https://moneybag-signals.com (custom domain; the original
`moneybag-access.harzpassage.workers.dev` still works too, but Telegram's
webhook API failed to resolve `*.workers.dev` when registering the
webhook, which is why the custom domain was added).
**Admin panel:** https://moneybag-signals.com/admin

## How it works

- Each access token is a random string stored in a KV namespace with
  `{ status: "trial" | "paid", createdAt, expiresAt }`.
- Visiting `/?t=<token>` checks the token, and if valid sets an `HttpOnly`
  cookie (so the token doesn't stay in the address bar) and redirects to `/`.
- `/` (no valid token/cookie) shows an access-denied page instead of the
  tool.
- `/admin` is a small password-gated panel to create trial links, extend a
  token after manual payment, and list all issued tokens. The password is
  never in the code — it's a Worker secret (`ADMIN_PASSWORD`), checked as a
  Bearer token on every `/admin/api/*` call.

This does **not** hide the tool's HTML/JS from someone who already has valid
access — anyone who can open the page can view its source. It only limits
*who* can open it and *for how long*.

## Deploy

1. Create the KV namespace once:
   ```bash
   npx wrangler kv namespace create ACCESS_KV
   ```
   Copy the returned `id` into `wrangler.toml` (`REPLACE_WITH_KV_NAMESPACE_ID`).

2. Set the admin password (never commit it):
   ```bash
   npx wrangler secret put ADMIN_PASSWORD
   ```

3. Deploy:
   ```bash
   npx wrangler deploy
   ```

## Using it

- Open `https://<your-worker>.workers.dev/admin`, enter the admin password,
  and click "Link erstellen" for a fresh 24h trial link to send someone on
  Telegram.
- After they pay (manually, e.g. via PayPal), take the token from their link
  and use "Verlängern" to extend their access by N days and mark it `paid`.
- "Alle Zugänge" lists every issued token with its status and expiry.

## Telegram auto-import

`POST /telegram-webhook` receives every new message from a Telegram bot
added as admin to the signal channel/group, filters for messages that look
like a signal card, and stores the latest one in KV. The tool's "Aus
Telegram importieren" button fetches it via `GET /api/latest-signal`
(gated by the same access-token check as the main page).

Setup (one-time):
```bash
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET   # any random string
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  --data-urlencode "url=https://moneybag-signals.com/telegram-webhook" \
  --data-urlencode "secret_token=<same random string>"
```
The bot token itself is never stored anywhere - it's only needed for this
one `setWebhook` call. Check current status with
`.../bot<TOKEN>/getWebhookInfo`.

## Keeping the tool in sync

`public/index.html` is a copy, not a symlink. After editing
`tools/moneybag-analyst.html` (e.g. syncing calibration values), copy it
over again before redeploying:

```bash
cp tools/moneybag-analyst.html worker/public/index.html
npx wrangler deploy
```

## Premium channel: live confirmation after 2 minutes

High-confidence cards are **not** posted to the premium channel right away.
The webhook queues them (KV key `premium:pending`), and a cron trigger
(`[triggers] crons = ["* * * * *"]` in `wrangler.toml`) runs every minute:

1. Once a queued card is at least 2 minutes old, the worker loads the
   InPlayFlux live-scanner feed (`maclarv8/GETAllMatches.php`) and finds the
   match by team names.
2. It re-checks the match live, the same way `scripts/live_radar.py` does.
   The signal is dropped if a goal has already fallen, a red card has
   appeared, or the match is at minute 70 or later. It is also dropped if
   the confidence model (on live minute, shots on target, radar and
   pre-match line) is under its threshold, or if the goal score from
   `calibration/goal_score.json` is below −2.
3. If everything still holds, the card is posted with a "✅ Live bestätigt"
   block (live minute, score, model, goal score, radar split, live Over
   quote). Otherwise it is logged with the reason.
4. If the match never shows up in the feed, or the feed can't be reached,
   the card is dropped after 8 minutes.

Late "Risiko" cards are still forwarded right away, but only from minute 72
or with Radar ≥ 410 (see reports/2026-10-06-premium-channel.md).

Odds: for every queued and risk card the worker also logs the live
over/under quote from the feed at signal time (`signalOdds`) and when it
posts (`postOdds`), including the line the quote belongs to. The feed shows
the market's main live line, so the quote matches the bet only when that
line equals the card's target line. Both show up in the admin panel and in
the CSV export (`signal_*` / `post_*` columns).

Log of all decisions (`pending`, `confirmed`, `rejected` with reasons):
```bash
curl -H "Authorization: Bearer <ADMIN_PASSWORD>" https://moneybag-signals.com/admin/api/confirm-log
```
The KV cost is one read per minute while nothing is queued. Writes only
happen when a card is queued or decided.
