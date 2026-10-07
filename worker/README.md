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

## Stake advice, result tracking and weekly summary

- Every premium post ends with a minimum quote and a stake in units:
  `💶 Nur setzen ab Quote 1,22 (Over 2.5) · Einsatz: 2 Einheiten`.
  - The minimum quote is 1 / expected hit rate, rounded up. The expected hit rate is the
    lower of the live model and the goal-score band; risk cards use 64.8 %.
  - Units are 2 for goal score ≥ +1, 1 otherwise, and 0.5 for risk cards.
  - If the logged live quote for the target line is already below the minimum, the post
    says to wait.
- Each posted card is tracked (`track:open`) and settled from the live feed every minute.
  - It counts as won as soon as total goals exceed the line.
  - It counts as lost once the match, last seen at minute 85 or later, has been gone from
    the feed for 10 minutes.
  - It counts as void if it is never seen late within 4 hours.
  - Results are stored as `result:*` and are part of the KV backup.
  - Profit in units is only computed when the logged quote is for the card's own line and
    at least the minimum quote.
- The admin panel shows this under **Bilanz** (7 or 30 days), including a preview of the
  weekly post. A second cron (`0 8 * * 1`, Monday 08:00 UTC) posts that summary to the
  premium channel.
- Writes to KV only happen when something changes (a post, a settled result, a match
  passing minute 85), so idle minutes cost two KV reads and no writes.
