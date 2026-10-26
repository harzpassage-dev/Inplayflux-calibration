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
| 🔥 High Confidence | confidence model ≥ threshold (O2.5 0.80, O3.5 0.75, O0.5 0.75; **O1.5 off** since 2026-10-17 via `LINES_OFF`, also for Half-Risiko); queued, re-checked live after 2 min (model with 5 pp tolerance, goal score ≥ −2, no goal/red card, market ≥ 60 %), then posted; unchecked fallback if the feed is down, and posted unchecked **at once** when the feed is only the guest preview (≤ `GUEST_FEED_MAX` 20 matches) and the match is not in it; with the secret `APIFOOTBALL_KEY` set, such cards wait the 2 min and are checked via API-Football instead (`fetchApiFootballLive`/`confirmBasic`: no goal, no red card, minute < 70 → posted as "live geprüft: kein Tor, keine Rote Karte"; goal/red → rejected; not found there until 4 min or API error/quota → unchecked) | 1 (2 if goal score ≥ +1, or O0.5 with pre-match line ≥ 4 – `strongO05`, since 2026-10-22) |
| 🟠 Half-Risiko | minute 68–69, below threshold, live goal score ≥ −7 | 0.5 |
| 🧪 Over 1.5 Test (since 2026-10-21, `O15_TEST_ENABLED`) | O1.5 card, minute ≤ 61, pre-match line ≥ 2.75 (model not used); webhook queues (`tier: "o15"`, fast), next minute run posts (`postO15Test`; goal/red card since the card → `o15:rej` if the match is in the feed); `O15_WR` 0.76 → Mindestquote 1.32; own tier on results page / weekly report / free channel | 0.5 |
| ⚠️ Risiko (**off** since 2026-10-13, `RISK_ENABLED`) | minute ≥ 70 and (≥ 72 or radar ≥ 410) | 0.5 |
| 🛡️ Under 3.5 ("mit Vorsicht setzen", **paused** since 2026-10-21, `UNDER_ENABLED`; shadow log keeps running) | non-premium O2.5 card, 2 goals, no red card, goal score ≤ 0, live line ≤ 3.5 (at 3.5 the under quote must be ≥ minimum quote 1.48; below 3.5 the post asks to check the Under 3.5 quote at the bookmaker); `UNDER_WR` 0.68 | 0.5 |

Plus: free public channel **@MoneyBagAnalyst** (`FREE_CHANNEL_ID`, CTA `FREE_CTA_URL`): weekly report
and the first 3 settled premium tips per day (won or lost, never picked by result, posted only
after the match is decided; `free:count:<day>`). Under 3.5 **shadow log** for every O2.5 card (`u35:YYYY-MM-DD`, admin "Under 3.5 (still
protokolliert)"), result tracking (`track:open` → `result:*`), weekly report Monday 08:00 UTC
(cron `0 8 * * 1`), private morning report to the owner daily 07:00 UTC except Mondays (cron `0 7 * * *`,
`sendDailyReport`/`dailyAdminText`: last 24 h per tier, voids, profit estimates, open tips, and a warning when a
line with ≥ 2 tips/day over the week got none – a switched-off InPlayFlux strategy), dedup per match + line (`claim:*`, 3 h) plus a minute-cron run lock (`lock:minute`) so
overlapping runs never post or settle a tip twice, when a tip is settled its premium post is edited to start with "✅ WIN – Tor in Minute X'" or
"❌ LOST …" (`postPremium` stores `msgId` + `msgText` in the tracked entry, `markPremiumPost`
calls `editMessageText`; posts from before 2026-10-14 evening have no id and stay unmarked),
every tracked tip stores `signalQuote` = `cardQuote(parsed)` (since 2026-10-22: the card's ⚖️ live-line odds; exact
when the live line is the target line, else Poisson λ from the card's line + the card's margin, `exact: false`);
`saveResult` prices with the feed quote for the own line, else `signalQuote` (`quoteEstimated`), and the results
page / weekly report / admin show profit for *every* tip at its signal quote (`profitAll`, from 20 tips) and for
tips at ≥ Mindestquote only. The owner does not bet every tip, so no manual quote entry. The owner's real entry is
"wait until the quote reaches 1.40": `waitOutcome` (stored as `wait` on each result, admin "Ergebnisse" line
"Warten bis Quote 1,40") estimates the entry minute (goal rate falls linearly to ~95', from `signalQuote.p/book`);
goal before entry → no bet, after → win at 1.40, no goal → loss; needs the exact goal minute. Goal minute: since
22.10. `settleTracked` takes the feed's `sonGolDakikasi` when exactly the one needed goal fell (`goalExact`), else
`resultMinute` is null (the guest feed shows matches late, the old feed minute was often wrong). **Early warning**
(`maybeWarn`, after each settled tip): last 30 decided tips of a tier below expected − 2 SD (`WARN_EXPECTED`:
premium 0.786, half 0.65, o15 0.76, under 0.68) or the 1.40-wait profit < 0 over ≥ 20 bets → one Telegram message
to ADMIN_CHAT_ID per tier and day (`warn:<tier>:<day>`). **Market comparison** (since 22.10.): results store `marketP`
(= `signalQuote.p`, fair market probability at signal time); `summarize().market` gives per tier the average
market expectation vs our hit rate, shown in admin "Ergebnisse" (green/red points; < 50 tips flagged). Every post shows a
**Mindestquote** = ceil(100 / win rate) / 100. Public **results page**
`/ergebnisse` (no token): all settled tips from `result:*`, hit rate per tier for 7/30 days/
total, 14-day bars, newest 150 rows; edge-cached 5 min (`RESULTS_CACHE_S`). Result records are
also stored as KV **metadata** so listing needs no per-key `get` (old keys get metadata
lazily, max 100 per call). Free-channel posts and the weekly report link to it.

**Public pages** (no token, all in `worker/src/index.js`, since 2026-10-25): `/` start page for visitors without an access
link (`landingPage`, live hit rates, price 20 €/month, PayPal, email, free 24 h test with request form `#test` → bot DM to
the owner, FAQ; a `?t=` link or the `mb_access` cookie still
opens the tool, a bad link gets the 403 access page), `/ergebnisse`, `/impressum`, `/agb`, `/widerruf`, `/datenschutz`
(`legalPage`; the last four need the Cloudflare vars IMPRESSUM_NAME / IMPRESSUM_ADDRESS, set 25.10., else 404; legal pages
are noindex), `/robots.txt` + `/sitemap.xml` (`/` and `/ergebnisse`; site verified in Google Search Console). The
privacy policy lists every data flow (Cloudflare, cookie, contact form → Telegram, GMX, PayPal, Telegram, optional
The Odds API key): any new external resource, cookie or tracker needs an update there first.

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
- **Guest preview since 2026-10-17**: without a VIP login the feed returns only ~15 matches, the ones
  furthest into the game (seen: 11 at 90'+, then 79', 75', 74', 66'). Cards at minute ~60 are
  usually missing, so the live check rarely runs; results still settle because matches show up
  near the end. Do **not** log the worker in with the owner's VIP account: the InPlayFlux Membership Agreement forbids bots/scraping and shared access (account ban without refund); the owner decided 2026-10-17 to take no risk. The 2-minute check uses API-Football instead (official API, own key).
- **Half-time cards** ("Target: HT Goal", strategies "Iy gol (Imported)" / "HT over 0.5", minute 1–20) bet
  on a goal before the break. The worker's parser returns `halfTime` without a line (never scored or
  posted), and `scripts/goal_drivers.py` `load` drops them for all models (they had polluted O0.5/O1.5).
- New exports: `python3 scripts/normalize_export.py RAW.csv --check-against data/<previous>.csv --write`.
- **CSV exports** from InPlayFlux: since 10-06 the date comes as `="DD/MM/YYYY, hh:mm:ss"`,
  split into two columns by the comma, and **one hour early**. Normalize to
  `="YYYY-MM-DD hh:mm:ss"`, +1 h (verify the shift against the previous export's overlap),
  save as `data/inplayflux_sinyaller_<date>.csv`. Dedup key: (Tarih, Maç, Strateji, Sinyal Dk).
- Export odds columns are for the market's **main line**, not the target line, and there is
  no live-line column, so ROI from exports is unreliable; say so.
- Market probability: Poisson λ solved from the live line (whole lines push, quarter lines
  split), same maths in worker (`marketLambda`) and tool step 3b.

## Recalibration routine (new export)

Weekly since 2026-10-22 (plan item 6): Monday 08:00 UTC the bot sends the owner a private "Wochen-Check"
(`adminWeeklyText`: 7-day hit rate per tier, market points, both profit estimates, reminder to export a
new CSV). With the upload, follow `.claude/skills/wochen-routine/SKILL.md`: `python3 scripts/weekly.py RAW.csv`
runs steps 1–5 below at once (stops if the time shift is not 0; report `reports/<date>-wochen-check.txt`),
then decide per tier on the new days and apply.

1. Normalize and add the CSV to `data/`.
2. `python3 scripts/recalibrate.py data/*.csv --split "<last export end>"` → check CV and the
   time split, then `--write` (thresholds via `--threshold LINE=VALUE`).
3. `python3 scripts/goal_drivers.py data/*.csv` (writes `calibration/goal_score.json`).
4. Copy the printed `CONFIDENCE_MODELS` and goal score points/bands into
   `worker/src/index.js`; recheck `RISK_WR`, `HALF_WR`; update the tool's `DEFAULT_CALIB`
   and the badge "📅 Kalibriert: …" in **both** `worker/public/index.html` and
   `tools/moneybag-analyst.html` (keep the two files identical).
5. `python3 scripts/o35_scoreline.py data/*.csv`: O3.5 by score, half-time cards and the Over 1.5 test
   rule on the new days (keep `O15_*` in the worker in line).
6. Write a dated German report in `reports/` and update this file.

## Code conventions and checks

- Branch `claude/page-radar-signal-analysis-bdok65`, PR #1. Cloudflare Workers Builds deploys
  `moneybag-access` from this branch (root `/worker`, `npx wrangler deploy`) about a minute
  after each push. Red checks "Workers Builds: inplayflux-calibration / inplayflux-calibr"
  belong to deleted projects and are harmless.
- Sessions often get their own branch (e.g. `claude/video-spieler-auswechseln-uzcyn5`): work there,
  open a PR **into `claude/page-radar-signal-analysis-bdok65`** and merge it when the owner wants it
  live (the iPad merge box is hard to find; Claude merged #2–#6 on request). After a merge, reset the
  session branch onto the base before new work. On non-production branches "Workers Builds:
  moneybag-access" is a Cloudflare **preview** build that always fails (also for docs-only commits);
  it does not block merging or the production deploy – comment once per PR, nothing else.
- Never post to Telegram from the webhook path: parallel webhook runs race on KV (no atomic
  check-and-set). The webhook only queues (`premium:pending`); the minute cron posts under its run lock
  and dedupes by `tipKey(tier, home, away, line)`.
- Before every push: `node --check worker/src/index.js`, **`node --test "worker/test/*.test.mjs"`** and
  `cd worker && npx wrangler deploy --dry-run`. The test suite (since 2026-10-22, `worker/test/helpers.mjs` fakes KV,
  the feed and Telegram; `worker.test.mjs` covers security, queue/dedupe, O0.5 units, O1.5 test, settling + exact
  goal minute, early warning, weekly check, results page, test posts, and that every inline admin script parses)
  also runs on GitHub for every push/PR (`.github/workflows/worker-tests.yml`). Add a test for every worker change.
  For UI changes still render the admin page in Playwright (`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`).
- The admin page is a JS **template literal**: inside it write `\\n` for a JS newline and never
  use `\'` (it turns into a bare quote and breaks the page).
- KV writes cost money/limits: batch per day key, write only on change. Account is on Workers
  Paid since 2026-10-11.
- Secrets live only in Cloudflare (ADMIN_PASSWORD, TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET,
  PREMIUM_CHANNEL_ID, ADMIN_CHAT_ID, optional APIFOOTBALL_KEY). Recovery steps: `RESTORE.md`.
- Security: access tokens are 32 hex chars and share the KV namespace with everything else;
  `getAccess` only accepts that format and records with a numeric `expiresAt` (a guessable key
  like `premium:pending` used to open the tool). `/admin/api/*` locks an IP after 10 wrong
  passwords for 15 min (`adminfail:<ip>`); passwords are compared in constant time; pages send
  X-Frame-Options / Referrer-Policy / nosniff.
- After a deploy, verify from the container: `curl -s -o /dev/null -w "%{http_code}"
  "https://moneybag-signals.com/?t=premium:pending"` must give 403; `curl -sI .../admin` must
  show `x-frame-options: DENY`. If the owner gets "Zu viele Fehlversuche", they just wait
  15 min (or delete `adminfail:<ip>` in KV). Recommended to them: admin password ≥ 16 chars.
- Admin test posts (`/admin/api/test-post`, `?line=0.5`, `?tier=half`, `?tier=under`, `?tier=o15`,
  `?target=free`) are marked TEST and are never tracked or logged. Admin "Bilanz-Grafik
  erstellen" draws the 7-day results as a 1080×1350 PNG in the browser; its button "An Gratis-Kanal senden" (double tap)
  uploads the PNG to `/admin/api/post-bilanz`, which posts it to the free channel with `sendPhoto` (Workers have no
  canvas, so drawing stays in the browser; the Monday "Wochen-Check" reminds the owner).
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
  last card. Do not show tiny samples (e.g. SoT 13+, n=173, was left out). When several cards
  can describe the same match (e.g. 0:0 cards from two strategies), count unique matches
  (day + match name).
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
| 3 | `tiktok-nullnull.mp4` (31 s) | "0:0 nach 60 Minuten – fällt noch ein Tor?" | 748 unique matches 0:0 at ~61' (`scripts/nullnull_stats.py`): 68 % another goal, 32 % stay 0:0; first goal 61–70' 18 %, 71–80' 22 %, 81–90' 21 %, 90+' 7 % (both halves within ±3 pp) |
| 4 | `tiktok-laender.mp4` (31 s) | "In welchem Land fällt am häufigsten noch ein Tor?" | countries with ≥ 250 scenes (`scripts/country_stats.py`, league name's first word): Finland 81 %, Poland 79 %, Norway 76 % vs Italy 70 %, Mexico 71 %, Brazil 68 % (avg 73 %); women 74 / youth 74 / men 72 % |
| 5 | `tiktok-joker.mp4` (31 s) | "Der Joker kommt – fällt jetzt noch ein Tor?" (substitutions) | rules (IFAB): 1970 2 subs, 1995 3, today 5 in max. 3 stoppages; data (`scripts/sub_stats.py`, 4,459 unique matches with a card at 58–63'): next-goal rate per minute 61–75' 2.4 % vs 76–90' 3.2 % (+31 %, both halves 2.4/3.2); the data has no substitution column, so the video says it shows *when* goals fall, not *who* scores |
| 6 | `tiktok-sicher.mp4` (31 s) | "73 % – klingt sicher. Ist es das?" (probability / streaks; owner asked for a "Quote" video, done without betting words for TikTok) | `scripts/streak_stats.py`, 11,610 scenes in time order: 72.8 % another goal (halves 73.1/72.1); blocks of 10: avg 2.7 without goal, 29 % of blocks ≥ 4 without (halves 28/30); longest run with goal 41, without goal 8 (8 in both halves) |
| 7 | `tiktok-frauen.mp4` (31 s) | "Wer schießt mehr Tore – Frauen oder Männer?" | `scripts/gender_stats.py`, unique matches (earliest scene), youth excluded: 864 women / 5,847 men, 685 leagues; goals per 90 up to the scene 3.0 vs 3.1 (halves 3.09/3.25, 2.76/2.85); another goal 75 vs 74 % (halves 74.6/74.7, 77.0/70.6 – not stable, so only "Gleichauf"); median 15 min to next goal both. Message: practically equal. `Ort Gol Atar` columns are unclear (avg ~3.3 per team), not used |
| 8 | `tiktok-ecken.mp4` (31 s) | "Viele Ecken = viele Tore?" | `scripts/corner_stats.py`, 8,620 unique matches (earliest scene at 50–75', median 60', 05.09.–17.10.): avg 6 corners; goals up to the scene 0–4 corners 2.0, 5–8 1.9, 9–12 1.9 (halves 2.14/2.08/2.06, 1.71/1.61/1.57; corr −0.05); another goal 75/74/73 % (halves 75/75/75, 73/73/71); in matches with a lead the leading team has more corners 52 % vs trailing 36 % (halves 50/37, 55/33), 13 % equal; 13+ corners left out (n=143). Message: corners show pressure, not goals |
| 9 | `tiktok-trainer.mp4` (31 s) | "3 Trainer-Sprüche im Daten-Check" | `scripts/trainer_stats.py`, 8,153 unique matches (earliest scene at 55–65', median 59', 05.09.–17.10.): "Die Null muss stehen" – 0:0 stays in 30 % (halves 28/31); "Das 2:0 ist das gefährlichste Ergebnis" – another goal at 0:0 70 %, 1:1 75 %, 2:0 77 % (halves 72/76/78, 69/74/77; who scores is unknown, said in the footnote); Herberger "Ein Spiel dauert 90 Minuten" – of next goals 20 % after 85' (halves 18.5/22), 7 % in stoppage time (6.4/6.9) |
| 10 | `tiktok-knapp.mp4` (31 s) | "Knapp oder klar – wann fällt das nächste Tor?" | `scripts/margin_stats.py`, 8,680 unique matches (earliest scene at 55–65', median 60', 05.09.–21.10., halves split 01.10.): another goal 0:0 70 %, level with goals 75 %, 1-goal lead 73 %, 2+ lead 77 % (halves 72/69, 75.5/75.4, 74/71, 77/77); next goal after 75' 49 % at a 1-goal lead vs 41 % at 2+ (48/50, 40/43); in stoppage time 7.7 vs 5.4 % (7.5/8.1, 5.5/5.2). Who scores is unknown (footnote) |
| 11 | `tiktok-methode.mp4` (31 s) | "Wie entstehen unsere Zahlen?" (method / behind the scenes, owner's topic) | steps: scene at ~60', wait for full time, count 8,680 unique matches; stability test shown with clear lead 77/77 % (kept) vs Spain 68/74 % (dropped, country check to 10.10.); example `scripts/method_stats.py`: 0:0 at 55–65' by pre-match goal expectation ≤ 2.5 64 % (182, halves 59/67) vs ≥ 3.75 82 % (131, halves 82/83); 'what we don't know': who scores, substitutions, weather/pitch |
| 12 | `tiktok-nutzen.mp4` (31 s) | "Bauchgefühl oder Daten?" (what such analyses are good for, owner's topic) | only numbers already checked for earlier videos: (1) myth – corners 75/74/73 % (video 8), (2) 0:0 by pre-match goal expectation 64 vs 82 % (video 11), (3) 1 in 5 next goals after 85', 7 % in stoppage time (video 9), (4) honesty – 73 % means 27 % no goal, runs of up to 8 scenes without a goal (video 6) |
| 13 | `tiktok-abseits.mp4` (31 s) | "Abseits!" (owner's topic "Abseits und Tore") | the exports have **no offside data**, so rule facts from IFAB Law 11 (no offside in own half, level with the second-last opponent, directly from throw-in/goal kick/corner; hands/arms not counted; position alone not an offence), VAR Bundesliga since 2017/18, semi-automated offside at the 2022 World Cup; data part reuses video 8: no offside from a corner, yet corners barely matter – another goal 75/74/73 % (8,620 matches); footnote says the data has no offside decisions |

- Ideas for next videos (check the numbers first with `scripts/myth_stats.py`-style splits):
  myths suggested in comments; 0:0: shots on target did not hold in both halves (7+ SoT 77 %
  vs 69 %), leave out; favourite leading by one (raw effect small: 69 % vs 73 %
  level, confounded by minute, only use with care); red cards (no clear effect: 72.8 vs
  72.3 %); "what the pre-match goal expectation tells you" (careful: no bookmaker wording).
- Posting: max. 1 video/day, evenings 18–21 h, owner answers every comment, ends each video
  with a question.
- **Instagram @torminute** (since 2026-10-21): same name, profile picture, rules and videos (as Reels, same
  captions). Bio (≤ 150 chars): "⚽ Fußball-Statistik aus 13.000+ Live-Spielszenen / 📊 Wann fallen Tore – und
  warum? / 🔍 Mythen im Daten-Check / 🔔 Neue Reels jede Woche". First post: intro carousel
  `marketing/instagram-intro-{1,2,3}.png` (1080×1350, source `instagram-intro.html?s=N`; 3 of 4 matches another
  goal after 60', 1 of 5 goals after 85', median 15 min; 8,680 matches, both halves stable).
- **YouTube Torminute @torminute-analyst** (since 2026-10-25, Shorts): same profile picture and rules, banner
  `marketing/youtube-banner.jpg` (2560×1440, text in the 1546×423 safe area, source `youtube-banner.html`); no links
  except TikTok/Instagram @torminute (YouTube also restricts gambling promotion). Long video 1 (owner's request "4 min
  about our method"): `marketing/youtube-methode.mp4` (4:00, 1920×1080, silent, source `youtube-methode.video.html` with
  `data-s/data-e/data-at` scene timing + `youtube-methode.render.mjs`); only numbers already verified for TikTok
  videos 1–12; title, description with chapter timestamps and a narration script in `marketing/youtube.md`. Narrated
  version `marketing/youtube-methode-ton.mp4` (owner wanted it "natürlicher, mit Begeisterung, gern übertrieben" plus fun in
  the background: offline TTS Piper, voice de_DE-thorsten_emotional (amused/surprised), livelier script in
  `marketing/youtube-methode.voice.py`, self-made royalty-free crowd/cheers/groove `youtube-methode.bg.py` ducked under
  the voice; numbers spelled out as words; burned-in captions keep the calmer original wording). Owner found the Piper
  voices robotic (25.10.); CapCut was too fiddly for them, so the final `youtube-methode-ton.mp4` uses **Chatterbox**
  multilingual TTS (Resemble AI, MIT licence, runs on CPU in a venv, ~40 s per sentence; German, exaggeration ~0.7),
  every take checked by faster-whisper and garbled tails re-generated (recipe in `marketing/youtube-methode.voice.py`).
  Use Chatterbox, not Piper, for future voice-overs. `youtube-methode-musik.mp4` = picture + background without voice.
- Meta rules (checked 21.10.): ads that promote or link to online gambling need Meta's written authorization
  with a gambling licence → no paid Instagram/Facebook ads for MoneyBag; offers with "guaranteed win" are
  banned outright; organic gambling posts are a restricted category (possibly 18+ / not recommended,
  not confirmed). Keep MoneyBag off Torminute; if ever on Instagram, only a separate account.
- Auto-posting: Claude cannot post to TikTok/Instagram (no access). OpusClip is connected but on the FREE
  plan (no API access; even Pro needs per-post approval in the app). Recommended to the owner: schedule
  posts in the apps (Instagram "Planen", TikTok web upload "Planen", ~10 days ahead). Weekly scheduled task
  "Torminute Wochen-Video" (id trig_01TmwaGTcKUy48D2mq19y4V7, set up 22.10. on the owner's request): Sundays 17:37
  Berlin, fresh session, builds one new stable-statistics video by the rules above, pushes it (marketing/, scripts/,
  CLAUDE.md only) and sends the mp4 to the owner (push notification). It stores no connectors (not needed: git only).

## Change log (latest first)

- 2026-10-26: six start-page design drafts (owner: people want more graphics, "erfrischend und seriös") in
  `marketing/designs/` (`gen.py` → `design-1..6.html/.png`, `uebersicht.jpg`; system fonts only, live numbers of 26.10.):
  1 Stadion bei Nacht, 2 Frischer Rasen, 3 Anzeigetafel, 4 Taktiktafel, 5 Klar & vertrauenswürdig, 6 Sport-Magazin.
  Owner picked **6 (Sport-Magazin)** the same day: `landingPageHtml` rebuilt in that style (red/black/white, diagonal
  stripe hero "Zahlen statt Gefühl.", live numbers bar, 14-day hit/lost SVG chart from `result:*`, red-edged info boxes,
  black price + trial blocks; same content, trial form, FAQ, 18+ footer and legal links; still no external resources).

- 2026-10-26: public contact address `kontakt@moneybag-signals.com` (`CONTACT_EMAIL`; Cloudflare Email Routing set up by the
  owner: rule kontakt@ → harzpassage@gmx.de, catch-all present, MX route1-3.mx.cloudflare.net + SPF checked) on the start
  page, Impressum, AGB, Widerruf, Datenschutz (mentions the forwarding) and `marketing/werbetexte.md`. `IMPRESSUM_EMAIL`
  still overrides it. Owner confirmed a test mail to kontakt@ arrived in GMX (26.10.). The GMX MCP connector in Claude
  sessions fails (SMTP/IMAP login rejected) – it cannot be used to send or read mail.

- 2026-10-25: narrated YouTube video `marketing/youtube-methode-ton.mp4` (final: Chatterbox natural German voice,
  Whisper-checked, over the self-made stadium/groove background).

- 2026-10-25: YouTube long video `marketing/youtube-methode.mp4` (4 min: data, counting, stability test, results,
  myths, limits) + `marketing/youtube.md` (title, chapters, narration script).

- 2026-10-25: TikTok video 13 `marketing/tiktok-abseits.mp4` (offside rules + corner myth; no offside data in the exports).

- 2026-10-25: 24h-test request form on the start page (`#test`, owner's choice "Formular"): name + Telegram name
  and/or email + 18+ checkbox → `/api/contact` with `kind: "trial"` (Telegram name alone is enough; normal contact form
  still needs an email; 60 s per-IP limit) → bot DM "🎁 Neue Anfrage: 24h-Test" with a t.me link to the owner
  (ADMIN_CHAT_ID). Owner then creates a 24 h access in admin and sends it on Telegram. Privacy policy updated.

- 2026-10-25: start page advertises a free 24-hour Premium test (hero note, price box, FAQ; request by email, ends
  automatically – admin "create" makes 24 h tokens); AGB § 4 (4) covers the free trial (no payment duty, no renewal).

- 2026-10-25: privacy policy `/datenschutz` (`legalPage` kind "datenschutz": Cloudflare hosting/logs, cookie `mb_access`,
  local storage, contact form → Telegram + IP 60 s, GMX email, PayPal, Telegram channels, optional The Odds API key,
  rights, BayLDA); footer links everywhere. Google Fonts removed from the tool (`worker/public/index.html` =
  `tools/moneybag-analyst.html`, system monospace fallback) so no IP goes to Google. Never add external fonts/scripts/
  trackers without updating `/datenschutz`.

- 2026-10-25: AGB + Widerrufsbelehrung (statutory model for services) + Widerrufsformular live at `/agb` and
  `/widerruf` (`legalPage`, name/address from the Impressum variables, 404 without them, noindex; owner chose
  Kleinunternehmer § 19 UStG and PayPal; source text + operator notes `legal/agb-entwurf.md`); footer links on `/`,
  `/ergebnisse`, `/impressum`. Owner should still have them checked (lawyer / e-recht24). Also missing: privacy
  policy (access cookie, contact form → Telegram, Cloudflare).

- 2026-10-25: Impressum live – owner set IMPRESSUM_NAME / IMPRESSUM_ADDRESS in Cloudflare (plain text vars, kept on
  deploy by `keep_vars`); `/impressum` 200, address in 3 lines, footer links on `/` and `/ergebnisse`. 

- 2026-10-25: public start page at `/` for visitors without an access link (`landingPage`/`landingPageHtml`, cached 5 min,
  live hit rates from `result:*`, how it works, free channel, Premium 20 €/month + email, FAQ, 18+ footer); a link with
  `?t=` or the cookie still opens the tool, an invalid/expired link still gets the 403 access page. `/` added to
  robots.txt (`Allow: /$`) and the sitemap.

- 2026-10-25: Google search: `/robots.txt` (only `/ergebnisse` allowed, admin/api/webhook blocked) and `/sitemap.xml`
  (lists `/ergebnisse`), canonical link on the results page. Domain verified in Google Search Console the same day
  (owner's Google account); sitemap submitted as full URL
  `https://moneybag-signals.com/sitemap.xml` (a domain property rejects the bare file name), live test of `/ergebnisse`
  green, indexing requested for `/` and `/ergebnisse` the same day. Check with `site:moneybag-signals.com` in ~1–2 weeks. 

- 2026-10-25: YouTube channel set up (banner, description); Shorts = TikTok videos.

- 2026-10-24: TikTok video 12 `marketing/tiktok-nutzen.mp4` ("Bauchgefühl oder Daten?", benefit of the analyses).

- 2026-10-24: export 10-24 added via `scripts/weekly.py` (time shift 0, no refit: only ~2.7 new days); O0.5 check –
  "Over 0.5 Value" now sends mostly low-line 0:0 games (27 cards, 70 %, none ≥ 3.75), so premium O0.5 is rare;
  owner advised to switch "MoneyBag 0-0 → Goal" back on. Owner's InPlayFlux strategy list noted (open items).

- 2026-10-22: weekly results image to the free channel with one tap in admin (`/admin/api/post-bilanz`, sendPhoto).

- 2026-10-22: scheduled task "Torminute Wochen-Video" (Sundays 17:37 Berlin) builds and sends one new video per week.

- 2026-10-22: `/impressum` page from Cloudflare variables (404 until set), footer link on `/ergebnisse`.

- 2026-10-22: daily private morning report to the owner (07:00 UTC, not Mondays) incl. "line went quiet" warning.

- 2026-10-22: per-card queue keys (`pending:*`) instead of one shared list – parallel webhook runs no longer drop
  cards (test "cards arriving at the same moment" fails on the old code, passes now).

- 2026-10-22: worker test suite `worker/test/` (11 tests, node:test) + GitHub Action `worker-tests.yml` (syntax, tests,
  wrangler dry-run on every push/PR); mutation check: a wrong O0.5 stake and a `\'` in the admin script both fail it.

- 2026-10-22: Under 3.5 recalculated on 164 strict log games: no rule holds in both halves, stays paused.

- 2026-10-22: weekly routine: Monday "Wochen-Check" DM to the owner, `scripts/weekly.py` (all analyses from one raw
  CSV), project skill `.claude/skills/wochen-routine/SKILL.md`.

- 2026-10-22: market comparison per tier in admin "Ergebnisse" (`marketP` per result).

- 2026-10-22: early warning to the owner via Telegram (`maybeWarn`), "wait for 1.40" entry estimate (`waitOutcome`),
  exact goal minute from `sonGolDakikasi` (banner/results no longer show the late feed minute).

- 2026-10-22: automatic quote per tip from the signal card (`cardQuote`, estimated via Poisson when the card's live
  line differs); profit shown for all tips at signal quote and for tips ≥ Mindestquote. First harness check: O0.5
  at 0:0 with live line 1.5 (2.10/1.70) → est. 1.20, O1.5 at 1:0 line 2.5 → 1.18 – both below the Mindestquote,
  so watch whether tiers beat the market at all.

- 2026-10-22: TikTok video 11 `marketing/tiktok-methode.mp4` (how the numbers are made, stability test, limits).

- 2026-10-22: O0.5 analysis (`scripts/o05_stats.py`); High Confidence O0.5 at pre-match line ≥ 4 posts with
  2 units (93.5 %, n=107, halves 93/94).

- 2026-10-21: TikTok video 10 `marketing/tiktok-knapp.mp4` (close lead vs clear lead: when the next goal falls).

- 2026-10-21: Over 1.5 test tier on the owner's request (min ≤ 61 + pre-match line ≥ 2.75, 0.5 units,
  min. quote 1.32, logs `o15:fwd/ok/rej`). Re-check at ≥ 100 live tips; switch off below ~72 %.

- 2026-10-21: recalibration with the 10-21 export (13,237 signals, thresholds unchanged), badge
  "Kalibriert: 21.10.2026 · 13.237 Signale", report `reports/2026-10-21-recalibration.md`, O3.5 scoreline /
  HT-goal / O1.5 analysis in `scripts/o35_scoreline.py`.

- 2026-10-21: Under 3.5 premium tips paused on the owner's request (`UNDER_ENABLED = false`) until the rule is
  recalculated; the `u35:*` shadow log keeps running; results page and weekly report label the tier
  "seit 21.10. pausiert". Re-enable only after a recalculation on the strict log (≥ 100 games).

- 2026-10-19: TikTok video 9 `marketing/tiktok-trainer.mp4` (three coach sayings checked against the data).

- 2026-10-18: TikTok video 8 `marketing/tiktok-ecken.mp4` (corners and goals, all exports up to 17.10.).

- 2026-10-17 night: admin "Unklare Ergebnisse nachtragen": the owner uploads an InPlayFlux CSV export (raw or
  normalized), `/admin/api/fill-unclear` (preview, `?apply=1` writes) gives void results (guest feed never showed
  the end) the export's outcome: same teams, same line, card time within 6 h of posting (`FILL_WINDOW_MS`, covers
  time zone + export shift), contradicting cards skipped; Under 3.5 from an O3.5 card, or won if the O2.5 card lost.
  Records get `filledFrom: "csv"`; the Telegram post is not re-marked. Test with the 10-17 export: 25 of 31 voids
  found, 15 won / 10 lost (60 %) – voids lean to losses, so hit rates without filling look too good.

- 2026-10-17 evening: triple posts (Swift Hesperange (W) – SC Ell (W), O3.5, three strategies at once). Cause: the
  "post at once" path posted from the webhook, so parallel webhook runs all got past the KV claim. Now the
  webhook only queues (guest-feed misses as `fast`, posted by the next minute run), `processPendingPremium`
  skips a tip already open or seen in the run (`tipKey`), `settleTracked` settles duplicates once, and
  `maybePostFree` posts a tip at most once (`free:sent:<tipKey>`). Known leftover: parallel writes to
  `premium:pending` can drop a card (read-modify-write on one KV key); harmless for duplicates.

- 2026-10-17: recalibration with the 10-17 export (12,582 signals, half-time cards excluded), report
  `reports/2026-10-17-recalibration.md`. Unseen 11.–17.10.: O2.5 81.9 % (182), O0.5 78.3 % (83), O1.5 70.0 % (30)
  → O1.5 premium/Half-Risiko off (`LINES_OFF`); no O3.5 cards since 10.10.; half-time cards ignored.

- 2026-10-17: unchecked High Confidence posts no longer carry "· ohne Live-Prüfung" in the header (owner's
  request; with no live source it was on every post). The reason is still logged (`premium:fwd` `unchecked`).

- 2026-10-17: API-Football free account was suspended within minutes (free plans are blocked on shared IPs
  such as Cloudflare Workers; a paid plan, ~19 $/month, lifts it). Owner chose **no live check** for now and
  removes the `APIFOOTBALL_KEY` secret (with the key set but the account blocked, cards wait 2 min and then
  fail over to unchecked). Code stays in place; re-adding the key on a paid plan re-enables the check.
  Highlightly (RapidAPI "Football Highlights API", free 100/day) was tested 17.10.: works from a datacenter
  IP, has live clock/score/events, but covers mostly top tiers (Poland only Ekstraklasa/I Liga, Italy only
  Serie A/B, Germany up to 3. Liga + one Oberliga), so most InPlayFlux cards (Polish III/IV Liga, Czech 4.
  Liga, Serie D, Kolmonen) would not be found and would only be delayed. Not built; owner stays without
  live check. API-Football (paid) is the only checked option with lower-league coverage.
- 2026-10-17: API-Football as second live source for the 2-minute check (goal / red card / minute only),
  active once the owner sets the Cloudflare secret `APIFOOTBALL_KEY`. No VIP login at InPlayFlux (ToS).
  The owner was also told that forwarding InPlayFlux card text to paying subscribers may need their
  permission; an English request email (API access + partnership) was drafted for hello@inplayflux.com.

- 2026-10-17: InPlayFlux guest feed limited to ~15 matches → High Confidence cards whose match is not
  in it are posted unchecked immediately (webhook) instead of after the 4-minute search.

- 2026-10-17: TikTok video 7 `marketing/tiktok-frauen.mp4` (women vs men, verdict: practically equal).

- 2026-10-16: TikTok video 6 `marketing/tiktok-sicher.mp4` ("73 % – wie sicher ist das?"). The owner wanted
  a video about odds; TikTok forbids betting words, so it explains probability and losing streaks only.
  Weekly results image/text now mark Risiko as "seit 13.10. abgeschaltet".

- 2026-10-16: TikTok video 5 `marketing/tiktok-joker.mp4` (substitutions / "Joker-Phase"). Exports
  contain no substitution data: rule facts from IFAB Law 3, goal timing from `scripts/sub_stats.py`
  (hazard of the next goal, counted per unique match); no claim that the substitute scores.

- 2026-10-16: Under 3.5 rule changed from the strict shadow log (81 games 11.–16.10.): goal score
  ≤ 0 + live line ≤ 3.5 → 18/25 = 72 % (non-premium 15/22 = 68 %, used as `UNDER_WR`);
  goal score ≥ +1 only 47 %; all 81 games 54 %; old rule (≤ −3, line 3.5) never fired.

- 2026-10-15: TikTok video 4 `marketing/tiktok-laender.mp4` (countries). Spain (68.5/74) and
  Argentina (66.5/77) were left out: not stable across the two halves.

- 2026-10-15: TikTok video 3 `marketing/tiktok-nullnull.mp4` (0:0 after 60 minutes; counted per
  unique match, not per scene, since 0:0 cards often come twice from two strategies).
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

## Open items (as of 2026-10-25)

- Improvement plan given to the owner 22.10. (profit first), worked through the same evening:
  - Done: (1) automatic quote per tip from the card (`cardQuote`, `waitOutcome`; owner does not bet every tip and
    waits for ≥ 1.40, so no manual entry), (2) market comparison per tier (`marketP`), (3) early warning
    (`maybeWarn`), (6) Monday routine (bot "Wochen-Check", `scripts/weekly.py`, skill `wochen-routine`), (8) worker
    tests + GitHub Action, (9) per-card queue keys, (10) daily morning report, (13) price 20 €/month + ad texts +
    `/impressum`, (14) weekly video task (Sundays), (15) weekly image to the free channel (one tap in admin).
  - Checked, deliberately unchanged: (4) O2.5 rule, (5) score as O3.5 feature, (7) Under 3.5 stays off,
    (11) live check not worth ~19 $/month now.
  - Waiting for the owner: switch "MoneyBag 0-0 → Goal" back on at InPlayFlux (24.10.); (12) **InPlayFlux permission** for forwarding to paying subscribers (email text given
    22.10.); legal check of `/agb`, `/widerruf`, `/datenschutz`;
    invite links per source in the free channel; paid ads only after an edge (≥ 50 tips) and InPlayFlux's answer.
- Own premium post format ("MoneyBag format", owner asked twice on 22.10.): built and tested (match, league,
  minute + score, tip, shots on target, "Druck-Index", pre-match goal expectation, live quote; a version with the
  line "ℹ️ Datenbasis: eigene Strategie auf InPlayFlux" too), but every attempt to push it was **blocked by Claude's
  safety check as acting against a third party (InPlayFlux)**; nothing is live, the repo was reset. Do not retry
  or work around it; rebuild it (~10 min) only once the owner has InPlayFlux's written OK for commercial
  forwarding, then mention that permission in the commit.
- O2.5 analysis 22.10. (`scripts/o25_stats.py`, 6,487 cards at 2 goals): since 01.10. almost all O2.5 cards come
  from "MoneyBag 2-0/0-2 → Over 2.5 New" (pre-match line ≥ 3.25 built in, minute 55–67, ~43 cards/day): raw 80.2 %
  (945); model ≥ 0.80 on it 81.1 % (486, ~22/day), unseen 17.–21.10. 78.3 % (83) vs raw 81.2 % (149). Simple rule
  line ≥ 3.25 & minute ≤ 63: 81.7 % (2,466, halves 82.3/81.0, unseen 81.6 %). Score (1:1 vs 2:0), SoT, radar barely
  matter. Conclusion: the strategy already filters, the model adds ~1 pp and halves volume; no change until the
  market comparison (≥ 50 tips) shows which O2.5 subset beats the market. Old "MoneyBag 2-0/0-2 → Over 2.5" 74.6 %.
- First quote check (harness, 2 cards): O0.5 at 0:0 est. 1.20 vs Mindestquote 1.23, O1.5 at 1:0 est. 1.18 vs 1.32
  → after ~1 week compare per tier: hit rate vs average signal quote and the 1.40-wait result in admin
  "Ergebnisse"; tiers that do not beat the market get stricter or switched off.
- Profit check (from 22.10.): once ≥ 20 tips with a signal quote are settled, `/ergebnisse` shows the profit lines.
  Compare per tier: average signal quote vs hit rate (break-even = 1 / hit rate). Tiers whose quotes sit below
  their Mindestquote lose money even at good hit rates → raise thresholds or switch off.
- Recalibration 21.10. (`reports/2026-10-21-recalibration.md`, 13,237 signals). Unseen 17.–21.10.: O2.5
  78.0 % (82) vs raw 81.2 % – filter does not beat the raw rate, watch it; O3.5 74.7 % (87) vs raw 69.1 %.
- O1.5 model tier (High Confidence / Half-Risiko) is off: re-enable only if a new export shows ≥ 75 % on unseen days. 21.10.: model 71.4 % (21);
  simple rule minute ≤ 61 + pre-match line ≥ 2.75 gives 76.1 % (522, halves 80.9/73.0), unseen 75.8 % (91)
  → borderline; owner said yes 21.10.: running as 🧪 Over 1.5 Test (0.5 units). Check it at ≥ 100 tips on
  `/ergebnisse`; switch off (`O15_TEST_ENABLED = false`) if it stays below ~72 %.
- O1.5 cards from InPlayFlux (owner's strategies, screenshot 21.10.): "Money Bag Over 1.5" (min 60–64, money
  movement = 1, pre-match line ≥ 3, since 20.10.), "Over 1.5 Value" (min 60–64, last-5 O2.5 ≥ 60 %, clear
  favourite, since 18.10.), "Over 1.5 ValueShots15" (same + total shots ≥ 15, since 18.10.); old "Over 1.5",
  "Over 1.5 cloude", "Over 1.5 claude 1.änderung" ended 17.10. Cards say `Target: Goal` at 1 goal, header
  "Over 1.5" → parsed as line 1.5. Export to 21.10. with our rule (min ≤ 61, line ≥ 2.75): Money Bag 79 % (19),
  Value 77 % (48), ValueShots15 71 % (24), old ones 74–78 % (431). Expected ~5–25 posts/day (one per match).
  Compare strategies one by one at ~100 tips; ValueShots15 is the candidate to switch off.
- O3.5 by score (`scripts/o35_scoreline.py`): 3:0/0:3 73 %, 2:1/1:2 69 %; 3:0/0:3 + min ≤ 63 + line ≥ 3
  78.2 % (698). Score as 5th model feature tested 22.10. (`scripts/o35_score_feature.py`): CV at 0.75 77.3 vs 78.2 %
  (worse), unseen 17.–21.10. 75.9 % (79) vs 74.7 % (87), best 80/120 75.0/76.7 vs 76.2/76.7 – no measurable gain
  (weight 0.08; minute and pre-match line already carry it). Not built; retest on the next export.
- O0.5 analysis 22.10. (`scripts/o05_stats.py`, 1,457 cards at 0:0, 1,194 matches): all 71 %; the pre-match line
  drives it (≤ 2.5 63 %, 2.75–3.0 70 %, 3.25–3.5 71 %, ≥ 3.5 81.5 % (325, halves 84/79), ≥ 4 93.5 % (107, halves
  93/94)); SoT, radar and minute barely matter (the model is mostly a line filter). Live High Confidence O0.5
  on `/ergebnisse` 18.–21.10.: 10/11 + 3 void. "MoneyBag 0-0 → Goal" sent no cards after 17.10. 19:46 (owner
  to check whether it is switched off). Owner said yes 22.10.: O0.5 High Confidence at line ≥ 4 gets 2 units
  (`O05_STRONG_LINE`); watch these tips on `/ergebnisse` (expected ~93 %, 2–3 per day).
- InPlayFlux "Live Strategies" list from the owner, 24.10. (their counts, not ours): Money Bag Over 1.5 79 % (81),
  Over 1.5 Value 77 % (116), Over 1.5 ValueShots15 75 % (52), HT Value12 66 % (137), MoneyBag 2-0/0-2 → Over 2.5 New
  81 % (721), Over 0.5 Value 75 % (222), MoneyBag + 3 Goals → Over 3.5 71 % (428), HT over 0.5 71 % (72).
  **"MoneyBag 0-0 → Goal" is not in the list → switched off** (no 0:0 cards since 17.10.); recommended to the owner to
  switch it back on (its line ≥ 3.75 cards hit 82 %, and High Confidence O0.5 + the 2-unit rule need 0:0 cards).
  HT strategies are ignored by the worker (could be switched off to keep the source channel clean).
- Export 24.10. (`data/inplayflux_sinyaller_2026-10-24.csv`, report `reports/2026-10-24-wochen-check.txt`, models not
  refitted). New days 21.10. 16:26 – 24.10. 09:27: O2.5 model 85.2 % (54) vs raw 83.0 % (94); O3.5 78.6 % (42) vs raw
  79.5 % (83); O1.5 test rule 81.1 % (127; Value 84 % (50), Money Bag 80 % (59), ValueShots15 78 % (18)); O0.5: only 27
  cards, all "Over 0.5 Value", 70.4 %, none with pre-match line ≥ 3.75 (median 2.75) → model passed 2. Value cards
  overall: line ≥ 3.5 84.5 % (161), ≥ 4 94.7 % (57, halves 91/100), ≤ 3.0 70 % (363). O0.5 premium needs the switched-off
  "MoneyBag 0-0 → Goal" (high-line games) back on.
- Half-time-goal tier: not recommended (466 cards 66 %, best subset ~72 %, low HT odds); parser keeps
  ignoring HT cards.

- Next (from 25.10.): Mon 26.10. bot "Wochen-Check" → owner exports a new CSV → weekly routine (skill `wochen-routine`);
  market comparison and profit check once ≥ 50 tips; first auto video Sun 25.10. 17:37; Google indexing check
  (`site:moneybag-signals.com`) ~1–2 weeks; legal texts to be checked by a lawyer / e-recht24 (drafted by Claude, not
  legal advice); owner to send one test request through the start-page form to see the bot DM; trial flow: DM → admin
  "Zugang erstellen" (24 h) → send the link on Telegram; per new customer: send the `/agb` link and get the "start now, pro-rata on withdrawal" consent in the
  email before unlocking (`legal/agb-entwurf.md`, operator notes); trade registration (Gewerbe) if not done.
- Owner to-dos (25.10.): upload the TikTok videos as YouTube Shorts (one per day; the YouTube app crashed on upload 25.10. –
  advised: title without emojis, update/restart the app, or upload via studio.youtube.com in Chrome desktop mode;
  Shorts titles max. 100 chars incl. hashtags, the app has no description field). Earlier: delete the duplicate Aston Villa U19 posts (14.10.) and the triple Swift Hesperange
  (W) – SC Ell (W) posts (17.10.) in the free and premium channels; put https://moneybag-signals.com/ergebnisse into the free channel description and
  under the article (never on TikTok).
- Check the first auto-marked premium posts (WIN/LOST edit, 17291bb). If a post stays
  unmarked: the tracked entry has no `msgId` (posted before the change) or Telegram refused the
  edit (bot must stay admin with "edit messages" right in the premium channel). Older posts
  are still marked by hand.
- Watch for double posts after the 17.10. fix (webhook only queues, `tipKey` dedupe, `free:sent:*`).
  If one appears: same card from several strategies → check `processPendingPremium`; two cron runs at
  once → run lock (`lock:minute`). Fixed 22.10.: the queue is one KV key per card (`pending:<receivedAt>:<id>`,
  `queuePremium` = single put, `readPending` = list + get, done keys deleted; the old `premium:pending` list is still
  read until empty). KV list is eventually consistent: a card can show up one minute later; a deleted key seen again
  is caught by the `tipKey` dedupe.
- Live check value (plan item 11, analysed 22.10. on 13,237 cards): the needed goal fell within 1 / 2 / 3 min
  after the card in 1.0 / 2.1 / 3.3 % of all cards; a red card at signal time (7.1 % of cards) makes no
  difference (71.8 vs 73.0 %). So the check would mainly drop ~1–2 % "already decided" tips (which today count as
  wins, ~1 pp too optimistic) and cost speed (2-min wait). API-Football Pro ~19 $/month (7,500 calls/day; prices from
  third-party listings, confirm on api-sports.io). Recommended to the owner: not now; if wanted, use the key for an
  instant check at posting time (no 2-min wait) instead of the delayed check.
- Live check: none for now (guest feed ~15 matches; API-Football free plan suspended on Cloudflare IPs;
  Highlightly lacks lower leagues). Re-enable by a paid API-Football plan + secret `APIFOOTBALL_KEY`
  (code ready). Owner was offered an email draft to InPlayFlux (API access / partnership, also about
  forwarding card text to paying subscribers) – not known whether it was sent.
- Marketing plan `marketing/werbeplan.md` (from 15.10.): funnel Torminute (stats only) → free
  channel → premium; per-source Telegram invite links for tracking; week 3–4 paid Telega.io
  test (50–150 €, target < 0.50 € per free subscriber); weekly KPI table to fill in.
- TikTok @torminute (videos 1–13 ready, see table above): owner uploads videos 1–13 (one per evening, with sound in the app), sets
  lamp videos private, posts the same videos as Instagram Reels / YouTube Shorts; next video from comment suggestions. Track followers/views per video in
  `marketing/tiktok.md`.
- Marketing: price set 22.10.: **Premium 20 € per month, requests by email to kontakt@moneybag-signals.com** (since 26.10.; before harzpassage@gmx.de);
  `marketing/werbetexte.md` rewritten 22.10. (no 2-minute live check claim any more, Under 3.5/Risiko removed, link =
  free channel t.me/MoneyBagAnalyst or a per-source invite link, results page linked). Paid ads (Telega.io) only after
  the market comparison shows an edge (≥ 50 tips) and InPlayFlux has answered (plan item 12). Owner told: a paid
  offer in Germany needs an Impressum/terms; `/impressum` built 22.10. (`impressumPage`, § 5 DDG, "kein Wettanbieter" note,
  shown only when the owner sets the Cloudflare variables IMPRESSUM_NAME and IMPRESSUM_ADDRESS (lines split by "|"),
  so the address stays out of the repo; linked from the results page footer; terms/AGB still missing, owner should
  have it checked (lawyer or e-recht24);
  `FREE_CTA_URL` still defaults to https://moneybag-signals.com. Ideas not built yet: referral
  links (extra days per paying referral), Tipstrr listing, Telega.io test.

- Under 3.5: **paused since 21.10., stays off after the recalculation of 22.10.** (`scripts/u35_stats.py` on
  `under35_log_2026-10-22.csv`: 164 strict games 11.–22.10., halves split 17.10.): all 52 % (56/47); old rule goal
  score ≤ 0 & live line ≤ 3.5 66 % (47) but 75 % → **47 %** (15) in the second half; line ≤ 3.0 81 → 55 %; market
  ≥ 60 % 73 → 50 %; goal score ≤ −2 & line ≤ 3.5 75 → 57 % (7). Nothing holds in both halves. Only live line exactly
  3.5 (real Under quote, avg 1.85): 52 games +2.9 units (−0.8 / +3.7 by half) – too small and unstable. Shadow log
  keeps running; retest at ≥ 300 strict games (~3 weeks).
- Market cut (60 %) is provisional: recalibrate from `market_proba` in the premium CSV export
  (`scripts/premium_report.py` prints hit rate by market band).
- Risiko tier switched off 2026-10-13 (8/20, then 4/9 live). Re-enable only after a new export
  shows it back above ~60 % on unseen days.
- High Confidence was 76 % out-of-sample on 06–10.10 (expected ~81 %); watch games with
  pre-match line ≥ 3.5.
