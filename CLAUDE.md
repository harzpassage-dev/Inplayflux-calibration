# CLAUDE.md – MoneyBag / InPlayFlux calibration

## Working with the owner

- The owner writes in **German** and works from an **iPad** (Chrome). Answer in German, short,
  plain language, no jargon. Show results as small tables; explain what they need to tap.
- Goal of the whole project: **profit** ("Gewinn erzeugen"). Prefer honest numbers over
  optimism; always say how big the sample is and whether a result was out-of-sample.
- Never ask for passwords or tokens in chat. Admin actions (test posts, exports, backup) are
  done by the owner in the admin panel; Claude cannot post to Telegram itself.

## What the system does

InPlayFlux (inplayflux.com) posts live betting "signal cards" into a Telegram signal channel.
The Cloudflare Worker `moneybag-access` (`worker/`, domain moneybag-signals.com) receives
every card via a Telegram webhook, scores it and forwards selected ones to a **premium
Telegram channel**. Every signal needs exactly **one more goal** (O2.5 at 2 goals, O3.5 at 3,
"Goal" at 0-0 = O0.5, O1.5 at 1).

Premium tiers (all in `worker/src/index.js`):

| Tier | Rule | Stake |
|---|---|---|
| 🔥 High Confidence | confidence model ≥ threshold (O2.5 0.80, O3.5 0.75, O1.5 0.80, O0.5 0.75); queued, re-checked live after 2 min (model with 5 pp tolerance, goal score ≥ −2, no goal/red card, market ≥ 60 %), then posted; unchecked fallback if the feed is down | 1 (2 if goal score ≥ +1) |
| 🟠 Half-Risiko | minute 68–69, below threshold, live goal score ≥ −7 | 0.5 |
| ⚠️ Risiko (**off** since 2026-10-13, `RISK_ENABLED`) | minute ≥ 70 and (≥ 72 or radar ≥ 410) | 0.5 |
| 🛡️ Under 3.5 ("mit Vorsicht setzen") | non-premium O2.5 card, 2 goals, goal score ≤ −3, live line exactly 3.5, under quote ≥ minimum quote | 0.5 |

Plus: free public channel **@MoneyBagAnalyst** (`FREE_CHANNEL_ID`, CTA `FREE_CTA_URL`): weekly report
and the first 3 settled premium tips per day (won or lost, never picked by result, posted only
after the match is decided; `free:count:<day>`). Under 3.5 **shadow log** for every O2.5 card (`u35:YYYY-MM-DD`, admin "Under 3.5 (still
protokolliert)"), result tracking (`track:open` → `result:*`), weekly report Monday 08:00 UTC
(cron `0 8 * * 1`), dedup per match + line (`claim:*`, 3 h) plus a minute-cron run lock (`lock:minute`) so
overlapping runs never post or settle a tip twice, when a tip is settled its premium post is edited to start with "✅ WIN – Tor in Minute X'" or
"❌ LOST …" (`postPremium` stores `msgId` + `msgText` in the tracked entry, `markPremiumPost`
calls `editMessageText`; posts from before 2026-10-14 evening have no id and stay unmarked),
every post shows a
**Mindestquote** = ceil(100 / win rate) / 100. Public **results page**
`/ergebnisse` (no token): all settled tips from `result:*`, hit rate per tier for 7/30 days/
total, 14-day bars, newest 150 rows; edge-cached 5 min (`RESULTS_CACHE_S`). Result records are
also stored as KV **metadata** so listing needs no per-key `get` (old keys get metadata
lazily, max 100 per call). Free-channel posts and the weekly report link to it.

## Data and feed facts (learned the hard way)

- **Live feed** `https://inplayflux.com/maclarv8/GETAllMatches.php?inplay=inplay&v=<ts>` needs
  header `X-IR-Token` + session cookie since 2026-10-07; both come from
  `HEAD https://inplayflux.com/live-scanner?page=open&lang=en&ir_token_refresh=1`
  (without them: 403 `IR_TOKEN_REQUIRED`). Feed fields: `minute, hg/ag, so` (SoT), `xg` (=
  Radar X), `p_goal` (pre-match line), `p_goal_h` (HT line), `p_avg_g_c`, `sonGolDakikasi`,
  `p_odds` (kickoff 1X2), `ou_odds = [over, under, live main line]`, `hrc/arc`, `id`.
- Card line `⚖️ O/U <pre-match> → <live line>  Over x  Under y`: the odds belong to the
  **live line**. Never average the two lines.
- Strategy headers like `💰 MONEYBAG 0-0 → GOAL` look like a team line; parsers must skip lines
  with `→`/`moneybag`. `Target: Goal` cards get line = current goals + 0.5.
- **CSV exports** from InPlayFlux: since 10-06 the date comes as `="DD/MM/YYYY, hh:mm:ss"`,
  split into two columns by the comma, and **one hour early**. Normalize to
  `="YYYY-MM-DD hh:mm:ss"`, +1 h (verify the shift against the previous export's overlap),
  save as `data/inplayflux_sinyaller_<date>.csv`. Dedup key: (Tarih, Maç, Strateji, Sinyal Dk).
- Export odds columns are for the market's **main line**, not the target line, and there is
  no live-line column, so ROI from exports is unreliable; say so.
- Market probability: Poisson λ solved from the live line (whole lines push, quarter lines
  split), same maths in worker (`marketLambda`) and tool step 3b.

## Recalibration routine (new export)

1. Normalize and add the CSV to `data/`.
2. `python3 scripts/recalibrate.py data/*.csv --split "<last export end>"` → check CV and the
   time split, then `--write` (thresholds via `--threshold LINE=VALUE`).
3. `python3 scripts/goal_drivers.py data/*.csv` (writes `calibration/goal_score.json`).
4. Copy the printed `CONFIDENCE_MODELS` and goal score points/bands into
   `worker/src/index.js`; recheck `RISK_WR`, `HALF_WR`; update the tool's `DEFAULT_CALIB`
   and the badge "📅 Kalibriert: …" in **both** `worker/public/index.html` and
   `tools/moneybag-analyst.html` (keep the two files identical).
5. Write a dated German report in `reports/`.

## Code conventions and checks

- Branch `claude/page-radar-signal-analysis-bdok65`, PR #1. Cloudflare Workers Builds deploys
  `moneybag-access` from this branch (root `/worker`, `npx wrangler deploy`) about a minute
  after each push. Red checks "Workers Builds: inplayflux-calibration / inplayflux-calibr"
  belong to deleted projects and are harmless.
- Before every push: `node --check worker/src/index.js` and
  `cd worker && npx wrangler deploy --dry-run`. Test changes with a local Node harness that
  imports the worker and mocks KV, `fetch` (feed + Telegram) and `Date.now`; render the admin
  page in Playwright (`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`) and check for JS
  errors.
- The admin page is a JS **template literal**: inside it write `\\n` for a JS newline and never
  use `\'` (it turns into a bare quote and breaks the page).
- KV writes cost money/limits: batch per day key, write only on change. Account is on Workers
  Paid since 2026-10-11.
- Secrets live only in Cloudflare (ADMIN_PASSWORD, TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET,
  PREMIUM_CHANNEL_ID, ADMIN_CHAT_ID). Recovery steps: `RESTORE.md`.
- Security: access tokens are 32 hex chars and share the KV namespace with everything else;
  `getAccess` only accepts that format and records with a numeric `expiresAt` (a guessable key
  like `premium:pending` used to open the tool). `/admin/api/*` locks an IP after 10 wrong
  passwords for 15 min (`adminfail:<ip>`); passwords are compared in constant time; pages send
  X-Frame-Options / Referrer-Policy / nosniff.
- After a deploy, verify from the container: `curl -s -o /dev/null -w "%{http_code}"
  "https://moneybag-signals.com/?t=premium:pending"` must give 403; `curl -sI .../admin` must
  show `x-frame-options: DENY`. If the owner gets "Zu viele Fehlversuche", they just wait
  15 min (or delete `adminfail:<ip>` in KV). Recommended to them: admin password ≥ 16 chars.
- Admin test posts (`/admin/api/test-post`, `?line=0.5`, `?tier=half`, `?tier=under`,
  `?target=free`) are marked TEST and are never tracked or logged. Admin "Bilanz-Grafik
  erstellen" draws the 7-day results as a 1080×1350 PNG in the browser.
- Marketing rules: only verifiable numbers, backtests labelled, no gain promises, always
  "18+ · Keine Gewinngarantie · Hilfe: check-dein-spiel.de"; free channel shows wins *and*
  losses (never cherry-pick); no spam DMs or hidden advertising.

## TikTok campaign (@torminute, since 2026-10-14)

- Account: display name **Torminute**, handle **@torminute** (owner's old lamp account
  @harzpassage2 renamed; ~40 lamp followers; old lamp videos to be set to private). Profile
  picture `marketing/torminute-profilbild.png` (source `torminute-profilbild.svg.html`). Bio:
  "⚽ Fußball-Statistik aus 11.000+ Live-Spielszenen / 📊 Wann fallen Tore – und warum? /
  🔔 Neue Daten jede Woche" (no hashtags in the bio, pronouns empty).
- **Hard rules** (TikTok bans organic gambling promotion; a strike kills reach): pure football
  statistics only. Never: bet/Wette/Tipp/Quote/odds/Signal/MoneyBag/Gewinn, money images, the
  money-bag logo, Telegram or site links (not in videos, captions, bio or comments, also not
  in DMs). The channel builds an audience; no conversion path to premium on TikTok.
- Numbers must come from `data/*.csv` (dedup key as above, 11,610 decided scenes 05.09.–
  10.10.2026), be stable in both halves of the period (split 2026-09-27) and be phrased as
  "share of scenes in which another goal fell before full time". Show the data basis on the
  last card. Do not show tiny samples (e.g. SoT 13+, n=173, was left out).
- Production: one HTML page per video with a `render(t)` timeline (navy/gold look, brand
  "⚽ TORMINUTE" at the top, captions burned in at `bottom:430px`, content kept out of the
  TikTok UI zones: top ≥ 260 px, right ≥ 150 px, bottom ≥ 600 px). `marketing/tiktok-*.render.mjs`
  screenshots 30 fps frames with Playwright, then
  `ffmpeg -framerate 30 -i f/%04d.jpg -f lavfi -i anullsrc=r=44100:cl=stereo -c:v libx264
  -pix_fmt yuv420p -crf 20 -c:a aac -shortest -movflags +faststart out.mp4`. Preview a
  contact sheet of single frames first (`node render.mjs 2,7,13`). Videos are silent; the
  owner adds a TikTok sound or text-to-speech in the app.
- Videos so far (see `marketing/tiktok.md` for captions):

| # | File | Topic | Key numbers |
|---|---|---|---|
| 1 | `tiktok-tore.mp4` (30 s) | "Das späte Tor ist kein Zufall" | 77/72/61/58 % by minute, median 15 min to goal, 7.7 % in stoppage time, goal rate per minute rises late |
| 2 | `tiktok-mythen.mp4` (31 s) | "3 Mythen über Tore im Daten-Check" | corners 73/72/73 % (no effect), < 5 min after a goal 69 % vs 75 %, SoT 72→73→76 % |

- Ideas for next videos (check the numbers first with `scripts/myth_stats.py`-style splits):
  myths suggested in comments; favourite leading by one (raw effect small: 69 % vs 73 %
  level, confounded by minute, only use with care); red cards (no clear effect: 72.8 vs
  72.3 %); "what the pre-match goal expectation tells you" (careful: no bookmaker wording).
- Posting: max. 1 video/day, evenings 18–21 h, owner answers every comment, ends each video
  with a question.

## Change log (latest first)

- 2026-10-14: premium posts are marked automatically when decided (✅ WIN / ❌ LOST banner on
  top via editMessageText), so the owner no longer marks them by hand.
- 2026-10-14: double-post fix: the minute cron takes a run lock (`lock:minute`, 110 s) only when
  it has work, because overlapping runs posted Aston Villa U19 twice (premium, results, free
  channel); `trackSignal` skips an open tip with the same match/line/tier; `listResults`
  drops duplicate results (tier+match+line+posting day), also for old records.
- 2026-10-14: public results page https://moneybag-signals.com/ergebnisse; result metadata
  for cheap listing; link in free-channel CTA and weekly report. Live check 14.10.: 147 decided
  tips since 07.10., High Confidence 111/135 = 82.2 %, all tiers 118/147 = 80.3 %.
- 2026-10-14: marketing plan `marketing/werbeplan.md`, campaign sheet `marketing/tiktok.md`.
- 2026-10-14: TikTok video 2 `marketing/tiktok-mythen.mp4` (31 s, "3 Mythen über Tore": corners no
  effect 73/72/73 %, <5 min after a goal 69 % vs 75 %, SoT 72→76 %; numbers from
  `scripts/myth_stats.py`, stable in both halves of the data).
- 2026-10-14: TikTok video `marketing/tiktok-tore.mp4` (30 s, 1080×1920, silent, brand "⚽ TORMINUTE"; source
  `tiktok-tore.video.html`, frames via `tiktok-tore.render.mjs` + ffmpeg). Pure football stats:
  no betting words, odds, links or money images (TikTok bans organic gambling promotion). TikTok account "Torminute", profile picture
  `marketing/torminute-profilbild.png` (stopwatch, gold 75–90 wedge, 90').
- 2026-10-13: marketing assets in `marketing/`: German ad texts (`werbetexte.md`), channel logos
  `moneybag-free-logo.png` / `moneybag-premium-logo.png` (1024², source `*.svg.html`, render
  with Playwright). Free channel listed for TGStat/Telemetr. No covert advertising (UWG §5a).
- 2026-10-13: free channel @MoneyBagAnalyst gets the weekly report + 3 finished tips/day;
  weekly report hides tiers without tips.
- 2026-10-13: Risiko tier off; weekly results image in the admin panel; profit line only from
  20 priced tips.
- 2026-10-13: security fix (access bypass via non-token KV keys), admin brute-force lock,
  security headers; CLAUDE.md added. Plugin review: nothing needed; `claude-md-management`
  would only automate keeping this file current (not installed).
- 2026-10-11: Under 3.5 premium tip, shadow log with goal score and the 85'+ rule; Workers Paid.
- 2026-10-10: recalibration with the 10-10 export (`scripts/recalibrate.py`), O0.5 threshold
  0.75, market probability in the 2-min check (cut 60 %).
- 2026-10-08: MoneyBag 0-0 → Goal cards parsed (were silently ignored), dedup per match/line,
  analyst tool step 3b uses the live line.
- 2026-10-07: feed token fix, Half-Risiko tier, admin test-post buttons.

## Open items (as of 2026-10-14)

- Owner to-dos: delete the duplicate Aston Villa U19 posts (14.10.) in the free and premium
  channels; put https://moneybag-signals.com/ergebnisse into the free channel description and
  under the article (never on TikTok).
- Check the first auto-marked premium posts (WIN/LOST edit, 17291bb). If a post stays
  unmarked: the tracked entry has no `msgId` (posted before the change) or Telegram refused the
  edit (bot must stay admin with "edit messages" right in the premium channel). Older posts
  are still marked by hand.
- Watch for double posts after the run-lock fix (c16ea4f); if one appears, check whether two
  cron invocations started at the same moment (KV has no atomic lock).
- Marketing plan `marketing/werbeplan.md` (from 15.10.): funnel Torminute (stats only) → free
  channel → premium; per-source Telegram invite links for tracking; week 3–4 paid Telega.io
  test (50–150 €, target < 0.50 € per free subscriber); weekly KPI table to fill in.
- TikTok @torminute: owner uploads video 1 and 2 (with sound in the app), sets lamp videos
  private; next video from comment suggestions. Track followers/views per video in
  `marketing/tiktok.md`.
- Marketing: owner to fill placeholders in `marketing/werbetexte.md` (premium link, price);
  `FREE_CTA_URL` still defaults to https://moneybag-signals.com. Ideas not built yet: referral
  links (extra days per paying referral), Tipstrr listing, Telega.io test.

- Under 3.5: live hit rate so far 71 % (111 games), at live line 3.5 76.6 % at Ø 1.89; only
  12 games measured with the "seen at 85'+" rule. Re-evaluate with ≥ 100 strict games.
- Market cut (60 %) is provisional: recalibrate from `market_proba` in the premium CSV export
  (`scripts/premium_report.py` prints hit rate by market band).
- Risiko tier switched off 2026-10-13 (8/20, then 4/9 live). Re-enable only after a new export
  shows it back above ~60 % on unseen days.
- High Confidence was 76 % out-of-sample on 06–10.10 (expected ~81 %); watch games with
  pre-match line ≥ 3.5.
