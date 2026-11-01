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
| 🔥 High Confidence | confidence model ≥ threshold (O2.5 0.80, O3.5 0.75, O0.5 0.75; **O1.5 off** since 2026-10-17 via `LINES_OFF`, also for Half-Risiko); queued, re-checked live after 2 min (model with 5 pp tolerance, goal score ≥ −2, no goal/red card, market ≥ 60 %), then posted; unchecked fallback if the feed is down, and posted unchecked **at once** when the feed is only the guest preview (≤ `GUEST_FEED_MAX` 20 matches) and the match is not in it; with API-Football configured (**active since 01.11.**, via the own proxy server – see API-Football section) such cards wait the 2 min and are checked via API-Football instead (`fetchApiFootballLive`/`confirmBasic`: no goal, no red card, minute < 70 → posted as "live geprüft: kein Tor, keine Rote Karte"; goal/red → rejected; not found there until 4 min or API error/quota → unchecked) | 1 (2 if goal score ≥ +1, or O0.5 with pre-match line ≥ 4 – `strongO05`, since 2026-10-22) |
| 🟠 Half-Risiko | minute 68–69, below threshold, live goal score ≥ −7 | 0.5 |
| 🧪 Over 1.5 Test (since 2026-10-21, `O15_TEST_ENABLED`) | O1.5 card, minute ≤ 61, pre-match line ≥ 2.75, men's first teams only since 29.10. (`nonMenMatch`: league/teams with U19…, Youth, Junior, Primavera, Reserve, Women, (W) are skipped; parser reads `league` from the 🏆 line) (model not used); webhook queues (`tier: "o15"`, fast), next minute run posts (`postO15Test`; goal/red card since the card → `o15:rej` if the match is in the feed); `O15_WR` 0.76 → Mindestquote 1.32; own tier on results page / weekly report / free channel | 0.5 |
| ⚠️ Risiko (**off** since 2026-10-13, `RISK_ENABLED`) | minute ≥ 70 and (≥ 72 or radar ≥ 410) | 0.5 |
| 🛡️ Under 3.5 ("mit Vorsicht setzen", **paused** since 2026-10-21, `UNDER_ENABLED`; shadow log keeps running) | non-premium O2.5 card, 2 goals, no red card, goal score ≤ 0, live line ≤ 3.5 (at 3.5 the under quote must be ≥ minimum quote 1.48; below 3.5 the post asks to check the Under 3.5 quote at the bookmaker); `UNDER_WR` 0.68 | 0.5 |

Plus: free public channel **@MoneyBagAnalyst** (`FREE_CHANNEL_ID`, CTA `FREE_CTA_URL`): weekly report
and the first 3 settled premium tips per day (won or lost, never picked by result, posted only
after the match is decided; `free:count:<day>`). Under 3.5 **shadow log** for every O2.5 card (`u35:YYYY-MM-DD`, admin "Under 3.5 (still
protokolliert)"), result tracking (`track:open` → `result:*`), weekly report Monday 08:00 UTC
(cron `0 8 * * 1`), private morning report to the owner daily 07:00 UTC except Mondays (cron `0 7 * * *`,
`sendDailyReport`/`dailyAdminText`: last 24 h per tier, voids, profit estimates, open tips, a warning when a
line with ≥ 2 tips/day over the week got none – a switched-off InPlayFlux strategy – and, from `VOID_REMIND` 10 open
voids in 7 days, a reminder to fill them from a CSV export), dedup per match + line (`claim:*`, 3 h) plus a minute-cron run lock (`lock:minute`) so
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
link (`landingPage`, live hit rates, price 20 €/month, PayPal, email, free 24 h test `#test` – since 31.10. automatic via the
bot (`/test-starten` → `/start test` → invite + tool link, removed after 24 h, see change log), FAQ; a `?t=` link or the `mb_access` cookie still
opens the tool, a bad link gets the 403 access page), `/ergebnisse`, `/impressum`, `/agb`, `/widerruf`, `/datenschutz`
(`legalPage`; the last four need the Cloudflare vars IMPRESSUM_NAME / IMPRESSUM_ADDRESS, set 25.10., else 404; legal pages
are noindex), `/videos` (MoneyBag versions of the statistics videos), `/partner` (partner network + join form),
`/robots.txt` + `/sitemap.xml` (`/`, `/ergebnisse`, `/videos`, `/partner`; site verified in Google Search Console). Every
public page has the fold-out menu (`NAV_LINKS`, "MENÜ" button left of the logo); new pages/sections go into it. The
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
  PREMIUM_CHANNEL_ID, ADMIN_CHAT_ID, APIFOOTBALL_KEY; plain vars AF_PROXY_URL / AF_PROXY_SECRET for the API-Football proxy). Recovery steps: `RESTORE.md`.
- **API-Football (since 01.11.)**: Pro plan (~19 $/month, 7,500 calls/day, until 01.12., credit card) reached only via the
  own proxy server (Hetzner CPX02 Nürnberg, 91.98.115.167, `af.moneybag-signals.com`, Caddy, `infra/af-proxy/cloud-init.yaml`,
  7.72 €/month) because API-Football rate-limits Cloudflare's shared IPs. Admin "API-Football prüfen" shows route, plan,
  calls and live matches. If the server is down or the proxy vars are removed, the worker falls back to the InPlayFlux feed
  (checks fail → unchecked posts, 4 h voids). Server care: unattended upgrades run on their own; a reboot (Hetzner
  "Herunterfahren" → "Einschalten") fixes a missing certificate. Owner should enable 2FA at Hetzner.
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
| 10 | `tiktok-elfmeter.mp4` (31 s) | "Elfmeter = sicheres Tor?" | not from our data (exports have no penalty column), sources on the last card: physics 10.97 m at 100 km/h ≈ 0.4 s; bundesliga.com 13.12.2021: 5,000 Bundesliga penalties, 74.9 % scored, 920 saved (18 %), 151 woodwork + 185 wide (7 %), records Abel 16/16, Kargus 23 saved; Bar-Eli et al. 2007 (J. Econ. Psych., 286 penalties): keepers jump 94 %, save 33 % when staying central vs ~13 % when jumping (small central n, disputed – said in the footnote) |
| 10 | `tiktok-knapp.mp4` (31 s) | "Knapp oder klar – wann fällt das nächste Tor?" | `scripts/margin_stats.py`, 8,680 unique matches (earliest scene at 55–65', median 60', 05.09.–21.10., halves split 01.10.): another goal 0:0 70 %, level with goals 75 %, 1-goal lead 73 %, 2+ lead 77 % (halves 72/69, 75.5/75.4, 74/71, 77/77); next goal after 75' 49 % at a 1-goal lead vs 41 % at 2+ (48/50, 40/43); in stoppage time 7.7 vs 5.4 % (7.5/8.1, 5.5/5.2). Who scores is unknown (footnote) |
| 11 | `tiktok-methode.mp4` (31 s) | "Wie entstehen unsere Zahlen?" (method / behind the scenes, owner's topic) | steps: scene at ~60', wait for full time, count 8,680 unique matches; stability test shown with clear lead 77/77 % (kept) vs Spain 68/74 % (dropped, country check to 10.10.); example `scripts/method_stats.py`: 0:0 at 55–65' by pre-match goal expectation ≤ 2.5 64 % (182, halves 59/67) vs ≥ 3.75 82 % (131, halves 82/83); 'what we don't know': who scores, substitutions, weather/pitch |
| 12 | `tiktok-nutzen.mp4` (31 s) | "Bauchgefühl oder Daten?" (what such analyses are good for, owner's topic) | only numbers already checked for earlier videos: (1) myth – corners 75/74/73 % (video 8), (2) 0:0 by pre-match goal expectation 64 vs 82 % (video 11), (3) 1 in 5 next goals after 85', 7 % in stoppage time (video 9), (4) honesty – 73 % means 27 % no goal, runs of up to 8 scenes without a goal (video 6) |
| 13 | `tiktok-abseits.mp4` (31 s) | "Abseits!" (owner's topic "Abseits und Tore") | the exports have **no offside data**, so rule facts from IFAB Law 11 (no offside in own half, level with the second-last opponent, directly from throw-in/goal kick/corner; hands/arms not counted; position alone not an offence), VAR Bundesliga since 2017/18, semi-automated offside at the 2022 World Cup; data part reuses video 8: no offside from a corner, yet corners barely matter – another goal 75/74/73 % (8,620 matches); footnote says the data has no offside decisions |
| 14 | `tiktok-jugend.mp4` (31 s) | "Jugend gegen Herren: Wer trifft öfter?" (owner's topic "U18 U20 U21 mehr Tore?") | `scripts/youth_stats.py`, unique matches with a scene at 55–65', 05.09.–26.10., halves split 01.10.; the data has **no U18** (only U19, U20, U21, U23): goals per 90 up to the scene U19 3.0 / U20–U23 3.0 / men 3.0 (halves 3.36/3.22/3.29, 2.56/2.67/2.57); another goal U19 79 % (595, halves 78/80) vs men 75 % (6,729, halves 75/74); U20–U23 75 % (580) but not stable (77/71, said in the footnote); share of next goals in stoppage time U19 5 % (5.0/4.8) vs men 7 % (6.6/7.9) |

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

- 2026-11-01 night: **live quote in the premium post** (owner: "Kannst du die Live Quote im Signal schreiben"). Before posting,
  `processPendingPremium` looks the match up in API-Football's live list and `odds/live` (`apiLiveQuote`, shared per run);
  `stakeAdvice` then adds "📈 Live-Quote jetzt: 1,36 (Over 2.5) – über der Mindestquote ✅" or "… – noch unter der
  Mindestquote ⏳ nur setzen, wenn sie steigt." (High Confidence checked/unchecked and Over 1.5 Test; the O1.5 "Quote:" line
  is left out then). The live quote also becomes the tracked tip's `odds` (prices the profit lines) and its `afId`. No
  live odds for the match → post as before (card quote hint). Test "live quote in the post".

- 2026-11-01 night: **API plan points 1 + 2** (owner: "fang mit Punkt 1 und 2 an"; quota 7,500/day mostly unused).
  (1) **Real live odds per tip**: while a tip is open and has an `afId` (also looked up by name for tips the InPlayFlux
  feed shows), one `odds/live` call per run (`afSource().odds()`, `afOddsLines`: every full-match goal over/under bet,
  half/team/corner bets and suspended prices skipped) feeds `recordOdds` → `t.ol` = first sighting (minute + lines from
  line − 0.5 to line + 1, e.g. 2.5/2.75/3/3.5 for an O2.5 tip), highest over price of the own line + minute, first minute
  ≥ 1.40 (`r140`, the owner's real entry). `saveResult` adds `oddsMinute/oddsOver/oddsUnder/oddsMax/oddsMaxMinute/
  odds140Minute/oddsQuarterOver/oddsNextOver/oddsNextUnder` (metadata + results CSV) and the full log `liveOdds` (value
  only, `resultMeta` drops it). Coverage of lower leagues unknown → admin button **"Quoten-Abdeckung prüfen"**
  (`/admin/api/odds-probe`: live matches, how many with live odds / with over-under, bet names, example, open tips ✅/—,
  archive count today). (2) **Own match archive**: the minute cron now runs every minute while API-Football is on
  (`collect`; the InPlayFlux feed is only fetched when there is work), `collectMatches` keeps the live ids in `af:prev`,
  fetches matches that left the list by id (`fixtures?ids=`, 20 per call, ≤ 60 per run, retried ≤ 10 runs) and stores
  finished/voided ones in `afm:<kickoff date>` (180 days): id, kickoff, country, league, teams, status, HT/FT score,
  events `G23h,P45+2a,O..,M..,R60h,S70a` (`afEvents`; no yellows). Admin **"Spiele-Archiv CSV (7 Tage)"**
  (`/admin/api/matches-csv?days=N`, max 180). Expected calls ~1,440 live + ~1,440 odds (only with open tips) + ~50 ids
  per day. Tests "API-Football live odds …", "own match archive …", "admin odds probe …".
  Next: owner taps "Quoten-Abdeckung prüfen" during busy hours → decide whether odds cover our leagues; after ~1 week the
  results CSV has real odds → quote filter (plan point 2) and the Over 3.0 test (`oddsNextOver`, `finalGoals`).

- 2026-11-01 evening: **settling via API-Football** (Pro plan active, admin check green: Pro, 7,500/day). A tip missing from
  the InPlayFlux guest feed is looked up at API-Football (`settleTracked` → `findApiFixture`, `afSource`): live list
  (`fixtures?live=all`, by stored `afId` or by team names – `findApiMatch`/`sameTeam`, tolerant to ø/æ/ß, hyphens, "FC"
  etc.), then `fixtures?id=` once it left the live list (max 15 per run), and if never found, the day list
  (`fixtures?date=`, ≥ 60 min after posting, once per run, per tip every 15 min). Finished (FT/AET/PEN, 90-minute score)
  → won/lost with the **exact goal minute** (`afGoalMinute`: the (line + 0.5)-th goal from the events) and `finalGoals`;
  PST/CANC/ABD/AWD/WO → void; never finished after 12 h → void. The posting check stores the fixture id (`afId`) in the
  tracked tip. Without the key everything works as before (InPlayFlux feed, 4 h void). If the InPlayFlux feed is down,
  tips are still settled via the API. Calls: ~1 live call/min while tips are open + lookups (~1,500–3,000/day).
  Tests "API-Football: …" (3). Admin check shows the live-list error if that call fails.
  Same evening the admin check showed "Too many requests … per minute" twice (17:31, 17:43; worked at 17:36): one
  API-Football source per run now (live list shared by posting check and settling), max 8 id lookups per run, 60 s pause
  per isolate after a rate-limit answer (`afPauseUntil`), and the admin check shows the per-minute limit from the
  response headers (`x-ratelimit-limit` / `-remaining`). If the limit shows 10 (free plan), ask API-Football support.
  Result 17:46: Pro, limit 300/min with 299 left, only 2 calls counted today, yet `fixtures?live=all` still answers
  "Too many requests … per minute" → API-Football apparently limits per **IP**, and Cloudflare Workers share egress IPs
  (same cause as the free-plan suspension 17.10.). Owner asked to write to support (rate limit per key / whitelist, else
  refund). Fallback options: refund, or API-Football via RapidAPI (key-based gateway; worker change ~10 min: header
  `x-rapidapi-key`, host api-football-v1.p.rapidapi.com, path `/v3/`). Until fixed the worker falls back as before.
  API-Sports support (chat bot) confirmed: shared Cloudflare IPs hit a network-level limit, no whitelist possible, only a
  dedicated IP helps; refunds via "Chat with an agent". Built the same evening: **RapidAPI route** – secret `RAPIDAPI_KEY`
  (preferred over `APIFOOTBALL_KEY`, `afOn`/`afRequest`), admin check shows "(RapidAPI)" or "(direkt)". Plan: owner tests
  RapidAPI's free Basic plan first; if the live list comes through → refund API-Sports, buy Pro on RapidAPI. Test
  "API-Football via RapidAPI".
  RapidAPI no longer lists API-Football (page "API not found", 01.11.). Owner chose **option B: own small server with a
  dedicated IPv4** (Hetzner Cloud, ~4–5 €/month) as proxy: `infra/af-proxy/cloud-init.yaml` (Ubuntu 24.04, Caddy reverse
  proxy for `af.moneybag-signals.com` → v3.football.api-sports.io, forwards only with header `X-Proxy-Secret`, drops
  X-Forwarded-*/CF-* headers, ufw 22/80/443, unattended upgrades; `__SECRET__` placeholder – the real value lives only in
  Cloudflare `AF_PROXY_SECRET` and on the server). Worker: `AF_PROXY_URL` + `AF_PROXY_SECRET` + `APIFOOTBALL_KEY` → calls go
  via the proxy (admin check shows "(eigener Server)"). DNS: A record `af` → server IP, DNS only (grey). Check from the
  container: `curl -s https://af.moneybag-signals.com/status` without the secret must give 403 "forbidden".
  Test "API-Football via own proxy server".
  **Live since 01.11. 18:59 Berlin:** Hetzner Cloud project "moneybag", server `ubuntu-1gb-nbg1-9` (CPX02, 1 vCPU / 1 GB,
  Nürnberg, 7.72 €/month incl. IPv4; Cost-Optimized was unavailable), IPv4 91.98.115.167, DNS `af` A record (DNS only).
  Caddy got its certificate only after a server restart (first attempts ran before the DNS record existed). Admin check:
  "(eigener Server) · Pro · 71 Live-Spiele · Limit 300/min (frei 289)". `AF_PROXY_URL` / `AF_PROXY_SECRET` were set as
  plain Variables in Cloudflare (works the same; kept on deploy by `keep_vars`). Monthly cost now ~19 $ API + 7.72 €
  server; review after 2–3 weeks (voids gone? exact minutes? real odds for Over 3.0 next). No refund requested.

- 2026-11-01: owner bought **API-Football Pro** (credit card; plan: test one month, then decide with real numbers) and set
  the secret `APIFOOTBALL_KEY` → the 2-minute live check via API-Football is active again. Admin button **"API-Football
  prüfen"** (`/admin/api/apifootball-status`, `apiFootballStatus`: `/status` plan/active/calls today + `fixtures?live=all`
  count, 2 calls). Planned next with the key: settle every tip (no voids) + exact goal minute + final score from
  API-Football, real live odds incl. Over 3.0 (check coverage of lower leagues first), instant check instead of the 2-min
  wait. Test "admin API-Football check".

- 2026-11-01: **final score per tip** (owner's yes, to test Over 3.0 / Over 2.0 on real outcomes instead of the hazard
  estimate): results get `finalGoals` (total goals at full time, also a column in the results CSV). A tip decided by its
  goal stays in `track:open` with `settledKey` (= its `result:*` key) and is watched like an open tip (`watchFinal`); when
  the match is gone after 85' for 10 min, `addFinalGoals` writes the last score seen into the record + metadata; never seen
  late → dropped without it after 4 h. Lost tips (gone after 85') get it at once. Watched entries are not counted as open
  (morning report, admin) but still block a re-post. Voids have none. First analysis once ~2 weeks of tips have it.
  Test "final score". Same day: MoneyBag version of the Elfmeter video on `/videos` (15 videos; the script also drops " 👇").

- 2026-10-31: TikTok video 10 `marketing/tiktok-elfmeter.mp4` (penalties; external sourced facts, like the IFAB rules in video 5).

- 2026-10-31: **automatic 24 h trial** (plan item 4, owner's yes). Start page `#test`: 18+ checkbox + button "Test auf Telegram
  starten" → `/test-starten` (302 to `t.me/<bot>?start=test`, bot name from `getMe`, cached in KV `bot:username`). In the bot,
  `/start test` → `startTrial`: one trial per Telegram user id (`trial:tg:<id>`, 1 year), max `TRIAL_MAX_PER_DAY` 30
  (`trial:count:<day>`, above that the owner is told), 24 h tool token (`putAccess`, `auto: true`), one-person premium invite
  link (`createChatInviteLink`, member_limit 1, valid 2 h), reply with both links + end time + 18+ line, DM to the owner with
  "/behalten <id>". `trialend:<ms>:<id>`: every 10 min (`endTrials` in the minute cron) the user is removed from the premium
  channel (ban + unban = kick, may rejoin as a customer) and gets a "Test vorbei" DM with the price; the owner's
  `/behalten <id>` (private chat with the bot) cancels the removal. **The bot needs the premium-channel admin rights "invite
  users via link" and "ban users"** (owner set both in "MoneyBag Premium Alerts" 31.10.: "Abonnenten hinzufügen" + "Nutzer
  sperren"); without them the owner gets a warning to do it by hand. The bot is @harzpassage_bot, display name "Sportfreunde"
  (renaming the display name via BotFather was suggested; a new username needs KV `bot:username` cleared). Privacy policy section 5 updated
  (Telegram id, username, 1 year). The old form API (`/api/contact` kind "trial") still works. Tests "automatic 24 h trial",
  "contact API trial kind".

- 2026-10-31: **bug fix – signal quote was missing on almost every tip** (found with the new results CSV: quote on 8 of
  1,326 tips, `marketP` on none). Real cards read `⚖️ O/U  2.75 → 1.25 📉   Over 1.73  Under 1.98`; the worker regex expected
  `Over` right after the live line, so the 📉/📈 arrow broke `cardOdds` → no `signalQuote`, `marketP`, `wait`, profit lines
  (the customer tool's regex already allowed it). Regex now skips non-digits before `Over`; the test card in
  `helpers.mjs` uses the real format (old code fails 2 tests). Market comparison / profit check (plan item 1) restarts from
  31.10. evening: needs ~1 week of new tips before a verdict.

- 2026-10-31: admin "Ergebnisse" button **"CSV speichern (30 Tage)"** (owner's wish for plan item 1, profit / market check):
  `/admin/api/results-csv?days=N` (password, max 365) → `resultsCsv` with postedAt, settledAt, tier, teams, line, minute,
  result, resultMinute, units, minQuote, quote, quoteEstimated, betPlaced, profit, marketP, waitEntry/Bet/Profit, filledFrom;
  download + copy textarea fallback (iPad). Test "admin results CSV". Owner then uploads the file here for the analysis.

- 2026-10-31: ROI image `marketing/roi-tabelle.png` (source `roi-tabelle.html`, design 6, 1080×1350): ROI = hit rate × quote − 1
  with live numbers (High Confidence 80.2 % → min. quote 1.25, +4/+12/+20 % at 1.30/1.40/1.50; Over 1.5 Test 75.5 % → 1.33,
  −2/+6/+13 %); note that the signal quote is often lower and waiting for 1.40 costs hits; the owner's "100 tips → 120 €"
  example was left out on purpose.

- 2026-10-31: many "ungewertet" (void) tips on a busy Saturday (Kazakhstan, Czech, Myanmar, Japan, U19 games): the guest feed's
  ~15 slots were full of stoppage-time games, so our matches never showed up and gave up after 4 h. InPlayFlux does **not**
  mark its cards with the result (owner checked the signal channel), so no free automatic source. Owner chose "CSV +
  reminder" over paid API-Football (~19 $/month, revisit once there are paying customers): the daily morning report adds
  "📥 N Tipps der letzten 7 Tage sind noch ungewertet …" with the fill steps once ≥ `VOID_REMIND` (10) voids are open
  (filled ones turn won/lost and drop out). Test "daily report: reminds the owner to fill voids".

- 2026-10-31: admin "Bilanz-Grafik erstellen" (`drawBilanz`) redrawn in design 6 (owner: "Wochenbilanz im neuen Design"):
  black top with red diagonal stripes, speed logo drawn on the canvas, italic "WOCHENBILANZ", big white total %, section
  "NACH STUFE" with black = hit / red = lost bars as on `/ergebnisse`, black footer with the results link + 18+ line.
  Example `marketing/bilanz-design6-beispiel.png`. Test "admin weekly image".

- 2026-10-31: weekly routine with export 10-31 (Saturday upload; `data/inplayflux_sinyaller_2026-10-31.csv`, shift 0,
  15,230 signals), models refitted, thresholds unchanged, goal score bands updated (points unchanged), badge "Kalibriert:
  31.10.2026 · 15.230 Signale", report `reports/2026-10-31-recalibration.md`. Unseen 26.–31.10.: O2.5 83.3 % (102) vs raw
  80.4 %, O3.5 76.8 % (95) vs 75.2 %, O0.5 76.6 % (47) vs 69.7 %, O0.5 line ≥ 4 9/10; O1.5 model 81.2 % (69) vs 73.6 % but
  68.7 % the week before → stays off. Over 1.5 Test (men) 73.8 % (149 matches), since the men filter 72.1 % (68) – at the
  cut, watch; by strategy Money Bag 74.6 % (134), Value 72.2 % (72), ValueShots15 75.9 % (29). "MoneyBag 0-0 → Goal" back
  (147 cards, raw 66 %). "Daten der Woche" now: score at minute 60 (0:0 70 / level with goals 76 / 1-goal lead 74 /
  2+ lead 77 %, 10,171 matches, both halves stable). Same day: admin password hint (below).

- 2026-10-31: owner got a bare "unauthorized" at admin "Unklare Ergebnisse nachtragen" (password field empty after a
  reload). The admin script now wraps `fetch` for `/admin/api/*`: empty field → "Bitte oben zuerst das Admin-Passwort
  eintragen …", 401 → "Passwort falsch – …" (applies to every admin button). Test "admin page: empty or wrong password".

- 2026-10-30: fold-out menu on every public page (owner: quick navigation, "noch so viele Ideen"): `NAV_LINKS` →
  `NAV_HTML` (HTML `<details class="mnav">`, hamburger with the word "MENÜ" written vertically, left of the logo, no script; a tap on a link closes it), built into
  `LOGO_HTML` (wrapped in `.topbar`), CSS in `LOGO_CSS`, so `/`, `/ergebnisse` and every `magHead` page (videos, partner,
  legal, 403) get it. Groups Start (Startseite, #daten, #so, #faq) / Zahlen & Inhalte (Ergebnisse, Videos) / Mitmachen
  (#test, #preis, free channel, Partner, Partner werden); legal links stay in the footers (404 without the Impressum vars).
  New ids on `/`: `so`, `preis`, `faq`. **Every new public page or section goes into `NAV_LINKS`.** Test "menu".

- 2026-10-30: partner page **`/partner`** (owner's idea: network of trusted Telegram channels that recommend each other).
  Marked "Partner-Kanäle · gegenseitige Empfehlung (Werbung)" (UWG), section "Warum dieses Netzwerk wichtig ist" (4 boxes: fake channels, orientation, together, openness), five rules (wins and losses shown, no guaranteed
  wins, no fixed matches/prepayment, 18+ note, active ≥ ~1 month), disclaimer for third-party content, join form
  `#mitmachen` → `/api/contact` `kind: "partner"` (name, channel `partnerChannel()` = t.me link or @name, description,
  Telegram name and/or email, two confirmations) → bot DM "🤝 Neue Partner-Anfrage". Partners are added by hand to
  `PARTNERS` ([name, link, text, topic, banner]) after the owner checked them; banners go to `worker/public/partner/`
  (served only if listed, own assets, links `rel="sponsored"`); no partner yet → "Das Netzwerk startet gerade".
  Footer links, robots.txt, sitemap; privacy policy section 5 mentions the form. Owner's message template for channel
  admins given in chat (German, asks for link, 1–2 sentences, banner ~1200×400 with permission). Test "partner page".

- 2026-10-30: partnership request sent by the owner from harzpassage@gmx.de to hello@inplayflux.com (English email:
  partner box + link on our site, free-channel mentions, their referral link, MoneyBag promotes InPlayFlux in the
  German-speaking market; asks for written permission to use signals from the owner's strategies in a paid channel +
  optional API access), attached image `marketing/inplayflux-partner.png` (source `inplayflux-partner.html`, text only,
  no InPlayFlux logo, partner box labelled "Mockup · proposed"). Nothing about a partnership on the live site until they
  agree; then build the partner box (and the blocked own premium format may be revisited with their written OK).

- 2026-10-30: video page **`/videos`** (owner's choice "MoneyBag-Fassungen"): MoneyBag versions of all 14 statistics
  videos, same numbers, MoneyBag speed logo instead of "⚽ TORMINUTE", red/black look, "@torminute" → "Mehr Daten:
  moneybag-signals.com", comment calls removed (`marketing/moneybag-videos.mjs [slug …]` → `worker/public/videos/<slug>.mp4`
  720×1280 ~0.6 MB + `<slug>.jpg` poster; it refuses to write a video that still contains "torminute"). Served from our
  own assets (`VIDEOS` list, byte ranges (206) cut in the worker because the asset binding returned 200 for Range requests and Safari/iPad only plays ranged video, no YouTube/TikTok player, no cookies → privacy policy
  unchanged); links in footers and under "Daten der Woche"; in robots.txt and the sitemap. Torminute stays separate
  (never link /videos from Torminute). For every new Torminute video: render the MoneyBag version and add it on top of
  `VIDEOS` (test expects the count). Test "videos page".

- 2026-10-30: owner asked about a football news feed on the site; advised against (press excerpts are protected in
  Germany, copied news gives no SEO value, external widgets need privacy/cookie changes, distracts from the trial). Built
  instead **"Daten der Woche"** on `/` (section `#daten` after the 14-day chart, `DATEN_DER_WOCHE` constant: one own
  analysis per week, bars + data basis, no external resources). First one: 0:0 at ~60' by pre-match goal expectation
  (`scripts/method_stats.py`, 1,290 matches 05.09.–26.10.): ≤ 2.5 64 % (210), 2.75–3.5 71 % (938), ≥ 3.75 82 % (142,
  halves 82/81), ≥ 4 89 % (82, halves 90/88). Refreshed with every weekly routine (skill section 6). Test added.

- 2026-10-29: owner asked for a rollback option ("vor der letzten Kalibrierung lief es besser?"). `scripts/compare_models.py`
  compares the old (21.10.) and new (26.10.) `CONFIDENCE_MODELS` on the same cards; for both unseen 26.10. 17:25 – 28.10.
  02:21: O2.5 84.8 / 84.8 % (33/33), O3.5 82.6 / 84.6 % (23/26), O0.5 80 / 75 % (5/4), all 83.6 / 84.1 % (61/63); before
  (21.–26.10., unseen for the old one) old 83.0 % vs new 82.7 % – practically the same picks. The felt drop came from the
  Over 1.5 Test (no model) and O0.5 voids, not from the recalibration → no rollback. Rollback procedure added to the
  skill `wochen-routine` (section 5).

- 2026-10-29: Over 1.5 Test men only (owner's yes after a league check, 601 unique matches 05.09.–28.10. under the test
  rule, halves split 12.10.): men 77.7 % (476, halves 79/77) vs women/youth/reserve 71.2 % (125, halves 70/72; at line
  2.75–3.0 only 60 %, n=35); countries all too small (England 71 % (52), Norway 72 % (29), "UEFA" 88 → 36 % (22)), not
  filtered. Expected ~20 % fewer O1.5 tips, ~78 %. Test "women, youth and reserve games are not posted" (fails without the
  filter). Same day: O0.5 premium 27.–28.10. 6/10 + 4 void (watch at the weekly routine; fill voids with the CSV).

- 2026-10-28: TikTok video 14 `marketing/tiktok-jugend.mp4` (youth vs men: same goals up to 60', U19 more often another goal).
- 2026-10-28: 24-hour check on the owner's request ("wir waren schlecht?", export 10-28 looked at only, not added to
  `data/`): `/ergebnisse` 27.10. 08:00 → 28.10.: High Confidence 29/35 = 83 % (O2.5 12/14, O3.5 16/19, O0.5 1/2), Over 1.5
  Test 22/32 = 69 % (9 losses in English/N. Irish non-league games around 22:00), all 51/67 = 76 %; O1.5 test since start
  205/270 = 75.9 % → kept. Export 27.10. 05:00–28.10.: test rule 74 % (54; Value 82 % (17), Money Bag Over 1.5 69 % (35)).
  Watch Money Bag Over 1.5 at the next weekly routine. Same day: Whop checked (see Marketing), video 14.

- 2026-10-27: SEO check after the owner pasted generic SEO tips: title, description, canonical, h1, lang, mobile, HTTPS,
  sitemap and Search Console were already in place. Added link previews: `ogMeta(title, desc, path)` (Open Graph +
  twitter card) on `/` and `/ergebnisse`, image `worker/public/og.png` (1200×630, source `marketing/og-bild.html`, no live
  numbers so it never goes stale) served publicly at `/og.png`, JSON-LD WebSite + Organization on `/`.
  Same day: owner re-created the deleted "MoneyBag 0-0 → Goal" at InPlayFlux (minute 61–71, total goals = 0, money-bag rule
  now called "Goal Line Signal (VU)" ≥ Yes, success criterion "Any goal scored"); worker parser and tool accept
  "Target: Any goal …" as well as "Target: Goal" (test), in case the card text changed with the new criterion.

- 2026-10-26: weekly routine with export 10-26 (`data/inplayflux_sinyaller_2026-10-26.csv`, 14,432 signals, shift 0),
  models refitted, thresholds unchanged, badge "Kalibriert: 26.10.2026 · 14.432 Signale", report
  `reports/2026-10-26-recalibration.md`. Unseen 24.–26.10.: O2.5 79.5 % (117) vs raw 78.5 %, O3.5 88.0 % (108) vs 79.8 %,
  O0.5 82.4 % (17) vs 72.7 %, O1.5 model 68.7 % (67, stays off); O1.5 test rule 73.5 % (291; Money Bag 75 %, Value 72 %,
  ValueShots15 70 % (43)); O0.5 line ≥ 4 6/8; no 68–69' cards; all 0:0 cards still "Over 0.5 Value".

- 2026-10-26: six start-page design drafts (owner: people want more graphics, "erfrischend und seriös") in
  `marketing/designs/` (`gen.py` → `design-1..6.html/.png`, `uebersicht.jpg`; system fonts only, live numbers of 26.10.):
  1 Stadion bei Nacht, 2 Frischer Rasen, 3 Anzeigetafel, 4 Taktiktafel, 5 Klar & vertrauenswürdig, 6 Sport-Magazin.
  Owner picked **6 (Sport-Magazin)** the same day: `landingPageHtml` rebuilt in that style (red/black/white, diagonal
  stripe hero "Analysen statt Gefühl." (was "Zahlen …", owner: sounds like paying), live numbers bar, 14-day hit/lost SVG chart from `result:*`, red-edged info boxes,
  black price + trial blocks; same content, trial form, FAQ, 18+ footer and legal links; still no external resources).
  `/ergebnisse` (`resultsPageHtml`) restyled the same way (black/red hero "Alle Ergebnisse", black table heads, black =
  hit / red = lost day bars, CTAs free channel + 24 h test; same data, texts and tests). Then all other public pages too:
  `MAG_CSS` + `magHead(title)` + `MAG_FOOT` shared by `impressumPage`, `legalPage` (AGB/Widerruf/Datenschutz) and
  `deniedPage` (403 access page, now with a link to the start page's 24 h test). Customer tool restyled too (design-6
  override block before `</style>` in `worker/public/index.html` = `tools/moneybag-analyst.html`); admin page not.
  10 logo drafts ("cool und jung") in `marketing/logos/` (`logos.html` → `logo-1..10.png`, `logos-uebersicht.png`):
  1 Speed-Kursiv, 2 Ball-O, 3 Trikot-MB, 4 Badge, 5 Chart, 6 Stencil, 7 Neon, 8 Split, 9 Tornetz, 10 Sticker;
  Owner picked **1 (Speed)** the same day: `LOGO_CSS`/`LOGO_HTML` (pure CSS: three red speed lines + italic MONEY white /
  BAG red, no font files) in every public page header, tool hero h1 styled the same; favicon `FAVICON_SVG` (black square,
  speed lines, italic "MB") at `/favicon.svg` (+ `/favicon.ico`), linked via `ICON_LINK` on all pages incl. admin.
  Telegram profile pictures in the same logo: `marketing/telegram-profil-{free,premium}.png` (1024², source
  `telegram-profil.html?v=free|premium`, round-crop safe); the owner sets them in the channels (replace the old money-bag logos).

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
  27.10.: coverage export (state 23.10.) showed 2 pages "blocked by 403" (before the start page existed; `/` and
  `/ergebnisse` answer Googlebot 200 now); owner started "Fehlerbehebung validieren" the same day.

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

## Open items (as of 2026-11-01)

- Improvement plan given to the owner 22.10. (profit first), worked through the same evening:
  - Done: (1) automatic quote per tip from the card (`cardQuote`, `waitOutcome`; owner does not bet every tip and
    waits for ≥ 1.40, so no manual entry), (2) market comparison per tier (`marketP`), (3) early warning
    (`maybeWarn`), (6) Monday routine (bot "Wochen-Check", `scripts/weekly.py`, skill `wochen-routine`), (8) worker
    tests + GitHub Action, (9) per-card queue keys, (10) daily morning report, (13) price 20 €/month + ad texts +
    `/impressum`, (14) weekly video task (Sundays), (15) weekly image to the free channel (one tap in admin).
  - Checked, deliberately unchanged: (4) O2.5 rule, (5) score as O3.5 feature, (7) Under 3.5 stays off,
    (11) live check not worth ~19 $/month now.
  - "MoneyBag 0-0 → Goal" re-created by the owner 26.10. evening, first card 28.10. parsed fine; (12) **InPlayFlux permission** for forwarding to paying subscribers (email text given
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
- Recalibration 26.10. (`reports/2026-10-26-recalibration.md`, 14,432 signals, models refitted, thresholds unchanged).
  Unseen 24.–26.10.: O2.5 79.5 % (117) vs raw 78.5 % – filter only ~1 pp above raw, wait for the market comparison;
  O3.5 88.0 % (108) vs raw 79.8 %; O0.5 82.4 % (17). O1.5 test rule 73.5 % (291) – only 1.5 pp above the 72 % cut;
  "Over 1.5 ValueShots15" 69.8 % (43) is the first to drop (decide at ~100 tips). Earlier (21.10., 13,237 signals):
  O2.5 78.0 % (82) vs raw 81.2 %, O3.5 74.7 % (87) vs raw 69.1 %.
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

- Next (from 31.10.): weekly routine done 31.10. (export 10-31); next ~Mon 09.11. (or 02.11. if the owner sends one); bot "Wochen-Check" → new CSV → skill `wochen-routine`;
  market comparison and profit check once ≥ 50 tips; auto video every Sunday 17:37; Google indexing check
  (`site:moneybag-signals.com`) ~1–2 weeks; legal texts to be checked by a lawyer / e-recht24 (drafted by Claude, not
  legal advice); trial is automatic since 31.10. (owner should test it once with a second Telegram account; customers from a
  trial: owner sends `/behalten <id>` to the bot and extends the tool token in admin); per new customer: send the `/agb` link and get the "start now, pro-rata on withdrawal" consent in the
  email before unlocking (`legal/agb-entwurf.md`, operator notes); trade registration (Gewerbe) if not done.
- Owner to-dos (26.10.): (new Telegram profile pictures set in both channels 27.10., done; auto WIN banner seen working
  on an Over 1.5 Test post; site link in the free channel description 27.10., done). First new "MoneyBag 0-0 → Goal" card arrived 28.10.
  (Alianza FC – CD Marathon, 61', line 2.75): header unchanged, still "Target: Goal", parsed fine (O0.5, SoT 1, radar 428),
  model 0.689 < 0.75 → correctly not posted.
  From 25.10.: upload the TikTok videos as YouTube Shorts (one per day; the YouTube app crashed on upload 25.10. –
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
- Live check + settling via API-Football **active since 01.11. evening** (own proxy server, see conventions). To check in
  the next days: voids in the morning report should drop to ~0; matches API-Football does not cover (very low leagues,
  name mismatch in `sameTeam`) still void → look at those and widen the matcher if needed; calls/day in the admin check.
  Next step: real live odds from API-Football (`odds/live`) for our leagues, incl. Over 3.0 → profit check of the
  Over 3.0 / Over 2.0 idea with real odds and `finalGoals`. Review cost (~19 $ + 7.72 €/month) ~20.11. Partnership/permission email to InPlayFlux **sent 30.10.** (see change log) – waiting for the answer.
- Marketing plan `marketing/werbeplan.md` (from 15.10.): funnel Torminute (stats only) → free
  channel → premium; per-source Telegram invite links for tracking; week 3–4 paid Telega.io
  test (50–150 €, target < 0.50 € per free subscriber); weekly KPI table to fill in.
- TikTok @torminute (videos 1–14 ready, see table above): owner uploads videos 1–14 (one per evening, with sound in the app), sets
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
  Whop (whop.com, checked 28.10.): storefront/marketplace for paid Telegram groups, auto add/remove members, merchant of
  record for EU VAT, affiliate program; ~3 % + card fees (~1.30 € per 20 € sub). Verdict with the owner: no value now
  (no paying customers yet, marketplace brings little reach); reconsider at ~10–20 customers, after InPlayFlux's OK; ask
  Whop support first whether German football-tip subscriptions are allowed.

- **Plan from 31.10. (owner's "Was könnten wir noch verbessern")**: (1) profit / market check per tier from the admin results
  CSV, (2) **owner said yes 31.10.**: stop posting tips that lose money at their signal quote – decide the cut per tier (e.g.
  `signalQuote.over` below a floor, or market p above our hit rate) from ~1 week of tips with quotes (parser fixed 31.10.
  evening), show the owner the numbers, then build it with a test; (3) Over 1.5 Test per strategy; (4) automatic 24 h trial
  (bot creates the token and sends the link – done 31.10.); (5) invite links per source; (6) fill the partner network; (7) legal check,
  Gewerbe; (8) InPlayFlux answer; (9) API-Football – done 01.11. (own proxy server). Next: owner sends the 30-day CSV ~07./08.11.
- Higher thresholds checked 31.10. (`scripts/threshold_walkforward.py`, model refit weekly, tested on the next unseen week,
  10.–31.10., counts are cards): O2.5 0.75 82.0 % (~40/day) / 0.80 81.4 % (~25/day, now) / 0.82 81.1 % / 0.84 85.9 % (~6/day,
  weeks 78/88/90) – the model barely separates between 0.75 and 0.82; O3.5 0.75 80.3 % (~15/day, now) / 0.80 83.0 % (~2/day);
  O0.5 0.75 79.6 % (~8/day, now) / 0.80 89.8 % (49 cards, ~2/day, weeks 91/91/87) / 0.82 96.6 % (29). **Owner chose to change
  nothing until the quote data is in** (~07./08.11.): higher hit rates usually come with lower quotes. Candidate then:
  O0.5 → 0.80.
- Two-goal lines checked 31.10. (owner: "O2.5 signals on Over 3, O1.5 on Over 2", `scripts/two_goal_estimate.py`). The exports
  have **no final score**, only whether the next goal fell and its minute, so the second goal is *estimated* by a hazard
  model (logistic: minute, pre-match line, goals, minutes since last goal; 10-fold group CV, well calibrated 55/67/75/83 %
  predicted vs 55/67/75/83 % real). Asian Over 3.0 at 2 goals: all 37 % win / 39 % push / 24 % loss → break-even 1.66; line
  ≥ 3.5 & minute ≤ 60 47/35/18 → **1.38** (folds 1.32–1.53, n=1,555); line ≥ 4 & ≤ 60' 52/32/16 → 1.30 (509). Over 2.0 at
  1 goal: test rule 34/42/24 → 1.72; line ≥ 3.5 → 1.42 (374). No odds for these lines in the data: an edge exists only if
  bookmakers pay more than the break-even – the model uses public info only, so the market may price the same. Next step
  offered: owner notes real Asian Over 3.0 odds on such signals, and/or the worker logs the final score so the strategy can
  be tested on real outcomes.
- Voids ("ungewertet", 31.10.): the guest feed misses many matches on busy days; InPlayFlux never marks cards with the
  result. Since 01.11. API-Football settles them (live list, fixture id, day list); CSV fill in admin + morning-report
  reminder stay as fallback.
- Over 1.5 Test after the men filter (29.10.): 72.1 % on 68 unseen matches – at the 72 % cut. Decide at the next weekly
  routine; "Over 1.5 Value" (72.2 %, 72) is the weakest strategy this week.
- Marketing images in design 6 for the free channel: weekly image (admin, `drawBilanz`), `marketing/roi-tabelle.png`
  (ROI at quotes 1.30/1.40/1.50 from live hit rates, 31.10.; no euro gain example – reads like a promise). Telegram only,
  never Torminute.
- Partner network `/partner`: no partner listed yet; owner contacts channels with the template (banner ~1200×400).

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
