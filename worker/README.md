# MoneyBag Access Worker

Gates `public/index.html` (a copy of `tools/moneybag-analyst.html`) behind
time-limited access tokens. No accounts — you generate a link per person via
the admin panel, they open it, get 24h of access, and after that see a
"please pay" page until you manually extend their token.

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

## Keeping the tool in sync

`public/index.html` is a copy, not a symlink. After editing
`tools/moneybag-analyst.html` (e.g. syncing calibration values), copy it
over again before redeploying:

```bash
cp tools/moneybag-analyst.html worker/public/index.html
npx wrangler deploy
```
