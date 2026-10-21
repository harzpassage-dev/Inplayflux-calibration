const COOKIE_NAME = "mb_access";
const DAY_MS = 24 * 60 * 60 * 1000;
const LATEST_SIGNAL_KEY = "telegram:latest_signal";

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// No framing (clickjacking), no referrer (access tokens in URLs), no MIME sniffing.
const SECURITY_HEADERS = {
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS },
  });
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function parseCookies(request) {
  const header = request.headers.get("Cookie") || "";
  const out = {};
  header.split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx === -1) return;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}

// Constant-time string comparison, so response timing does not leak how much
// of a guessed password was right.
function safeEqual(a, b) {
  a = String(a);
  b = String(b);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function isAdminAuthed(request, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const auth = request.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/);
  return !!m && safeEqual(m[1], env.ADMIN_PASSWORD);
}

// Brute-force guard for /admin/api/*: after ADMIN_MAX_FAILS wrong passwords
// from one IP within ADMIN_LOCK_S, that IP is locked out until the window
// ends. Only failed attempts cost a KV write.
const ADMIN_MAX_FAILS = 10;
const ADMIN_LOCK_S = 15 * 60;

async function adminGate(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const key = `adminfail:${ip}`;
  const fails = Number(await env.ACCESS_KV.get(key)) || 0;
  if (fails >= ADMIN_MAX_FAILS) {
    return jsonResponse({ error: "Zu viele Fehlversuche. Bitte 15 Minuten warten." }, 429);
  }
  if (isAdminAuthed(request, env)) return null;
  await env.ACCESS_KV.put(key, String(fails + 1), { expirationTtl: ADMIN_LOCK_S });
  return jsonResponse({ error: "unauthorized" }, 401);
}

// Access tokens are 32 hex chars (randomToken). Everything else in KV
// (logs, queues, "u35:<date>", "telegram:latest_signal", ...) shares the
// namespace, so a token from a URL or cookie must look like a token and the
// record like an access record; otherwise any guessable KV key would open
// the tool.
const TOKEN_RE = /^[0-9a-f]{32}$/;

async function getAccess(env, token) {
  if (!token || !TOKEN_RE.test(token)) return null;
  const raw = await env.ACCESS_KV.get(token);
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw);
    if (!rec || typeof rec !== "object" || typeof rec.expiresAt !== "number") return null;
    return rec;
  } catch (e) {
    return null;
  }
}

async function putAccess(env, token, record) {
  // Keep the record around for 30 days past expiry so an expired trial can
  // still be looked up and extended after manual payment.
  const ttlSeconds = Math.max(60, Math.floor((record.expiresAt - Date.now()) / 1000) + 30 * 24 * 60 * 60);
  await env.ACCESS_KV.put(token, JSON.stringify(record), { expirationTtl: ttlSeconds });
}

async function sendTelegramMessage(env, chatId, text, replyToMessageId) {
  const payload = { chat_id: chatId, text };
  if (replyToMessageId) payload.reply_to_message_id = replyToMessageId;
  const resp = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await resp.json().catch(() => null);
  return data && data.ok ? data.result : null;
}

const DISPOSABLE_EMAIL_DOMAINS = new Set([
  "mailinator.com", "guerrillamail.com", "guerrillamail.info", "temp-mail.org",
  "tempmail.com", "10minutemail.com", "10minutemail.net", "throwawaymail.com",
  "yopmail.com", "trashmail.com", "fakeinbox.com", "getnada.com", "maildrop.cc",
  "dispostable.com", "sharklasers.com", "mailnesia.com", "test.com", "example.com",
  "fake.com", "none.com", "nomail.com", "noemail.com",
]);

function looksLikeFakeEmail(email) {
  const at = email.lastIndexOf("@");
  if (at === -1) return false;
  const local = email.slice(0, at).toLowerCase();
  const domain = email.slice(at + 1).toLowerCase();
  if (DISPOSABLE_EMAIL_DOMAINS.has(domain)) return true;
  // "report@report.com", "test@test.com": local part equals the domain's
  // first label - a classic throwaway/placeholder pattern.
  const domainFirstLabel = domain.split(".")[0];
  if (local === domainFirstLabel) return true;
  return false;
}

function looksLikeSignalCard(text) {
  if (!text) return false;
  // Loose heuristic: signal cards always name a league (trophy emoji) and a
  // target market, and use the "min' ... min left ... HT x-y" time line.
  // This filters out ordinary chat messages in the same group/channel.
  const hasLeague = /🏆/.test(text);
  const hasTarget = /Target:/i.test(text);
  const hasTime = /\d+'\s*[\s·•]+~?\d+\s*min left/i.test(text);
  return hasLeague && hasTarget && hasTime;
}

// ---------------------------------------------------------------------
// High-confidence auto-forward: parse just enough of the signal card to
// score it with a small logistic-regression model (fit offline on the
// deduped Sept 2026 exports, see reports/2026-09-30-calibration.md) and,
// if the model's win probability clears the strategy's threshold, forward
// the original card to a "premium" Telegram channel. Only O2.5 and O3.5
// have a validated model so far - other strategies are left alone.
const CONFIDENCE_MODELS = {
  // targetLine -> { mean, std, coef, intercept, threshold } for features
  // [minute, total_sot, radar, goalline_pre]. Generated by
  // scripts/recalibrate.py from all exports up to 2026-10-21 (13,237 decided
  // signals, half-time cards excluded), grouped by target line. Unseen days
  // 17.-21.10. (model fit up to 17.10.): O2.5 78.0% n=82, O3.5 74.7% n=87,
  // O0.5 93.3% n=15, O1.5 71.4% n=21 (premium stays off, see LINES_OFF).
  2.5: {
    mean: [57.5371, 5.821, 322.028, 3.0485],
    std: [4.3802, 2.4464, 80.0601, 0.6252],
    coef: [-0.2513, 0.0768, 0.0284, 0.2516],
    intercept: 1.1471,
    threshold: 0.80,
  },
  3.5: {
    mean: [61.9928, 7.087, 333.7607, 3.0139],
    std: [3.0947, 2.5806, 82.3618, 0.6637],
    coef: [-0.2187, 0.0919, 0.0261, 0.1964],
    intercept: 0.8776,
    threshold: 0.75,
  },
  1.5: {
    mean: [62.9431, 5.8181, 372.0611, 3.1804],
    std: [4.0363, 2.3283, 68.8214, 0.4919],
    coef: [-0.4218, -0.0734, 0.1248, 0.2019],
    intercept: 0.9423,
    threshold: 0.80,
  },
  0.5: {
    mean: [61.3452, 4.0933, 330.9561, 3.0872],
    std: [0.5901, 2.5342, 80.4395, 0.5105],
    coef: [-0.0184, 0.0052, 0.041, 0.2913],
    intercept: 0.9189,
    threshold: 0.75,
  },
};

function parseForConfidenceScore(text) {
  const out = {};
  // Half-time cards ("Target: HT Goal", "Iy gol" / "HT over 0.5" strategies) bet
  // on a goal before the break, a different market than everything here: no
  // target line, so they are never scored, posted or tracked. ("HT 0-0" in the
  // time line is the half-time score and does not count.)
  const header = text.split(/Target:/i)[0];
  if (/Target:\s*(HT|1st half|first half|İY|IY)\b/i.test(text) || /\bHT\s*over\b|\bI[yY]\s*gol\b|\bİY\b/i.test(header)) {
    out.halfTime = true;
    return out;
  }
  let m = text.match(/Target:\s*Over\s*([\d.]+)\s*Goals/i);
  if (m) out.targetLine = parseFloat(m[1]);

  // Fallback for generic "Target: Goal" cards (Over 1.5 / Over 0.5 / MoneyBag
  // 0-0 templates) - mirrors tools/moneybag-analyst.html's parser. Requires
  // an actual decimal ("1.5", "0.5", ...) so a bare progress-counter digit
  // (e.g. the "1" in "1/2 goals") next to "Target: Goal" isn't mistaken for
  // the goal line.
  if (out.targetLine == null) {
    const targetLineMatch = text.match(/Target:\s*([^\n\r]+)/i);
    if (targetLineMatch) {
      const numMatch = targetLineMatch[1].match(/(\d+\.\d+)/);
      if (numMatch) out.targetLine = parseFloat(numMatch[1]);
    }
  }
  if (out.targetLine == null) {
    m = text.match(/MONEYBAG[^\n]*→\s*OVER\s*([\d.]+)/i);
    if (m) out.targetLine = parseFloat(m[1]);
  }
  if (out.targetLine == null) {
    const headerText = text.split(/Target:/i)[0];
    m = headerText.match(/Over\s*([\d.]+)/i);
    if (m) out.targetLine = parseFloat(m[1]);
  }

  m = text.match(/(\d+)'[\s·•]+~?\d+\s*min left/i);
  if (m) out.minute = parseInt(m[1], 10);
  m = text.match(/Shots\s*(\d+)\s*[·•]\s*(\d+)\s*\/\s*\d+\s*[·•]\s*\d+\s*total/i);
  if (m) out.totalSot = parseInt(m[1], 10) + parseInt(m[2], 10);
  m = text.match(/Radar X:.*?\((\d+)\)/i);
  if (m) out.radar = parseInt(m[1], 10);
  m = text.match(/O\/U\s*([\d.]+)\s*→/i);
  if (m) out.goallinePre = parseFloat(m[1]);
  // Team/score line. Skips strategy headers like "💰 MoneyBag 0-0 → Goal",
  // which have the same "name n-n name" shape.
  for (const tm of text.matchAll(/^(?:📊|📖|⚽|🥅|🏟️|🆚|⚔️)?\s*(.+?)\s+(\d+)\s*[–-]\s*(\d+)\s+(.+?)\s*$/gmu)) {
    if (/→|moneybag/i.test(tm[0])) continue;
    out.homeTeam = tm[1].replace(/^[^\p{L}\p{N}]+/u, "").trim();
    out.awayTeam = tm[4].trim();
    out.goals = parseInt(tm[2], 10) + parseInt(tm[3], 10);
    break;
  }
  // Generic "Target: Goal" cards (MoneyBag 0-0 -> Goal): every strategy needs
  // exactly one more goal, so the line is the current goals + 0.5.
  if (out.targetLine == null && out.goals != null && /Target:\s*Goal\b/i.test(text)) {
    out.targetLine = out.goals + 0.5;
  }
  m = text.match(/Strike Rate:\s*(\d+)%/i);
  if (m) out.feedWR = parseInt(m[1], 10);
  return out;
}

// Target lines whose cards are never posted (premium or Half-Risiko); they are
// still scored and logged. O1.5 off since 2026-10-17: 70% on the unseen days
// 11.-17.10. (n=30) against ~80% promised, i.e. a loss at the shown Mindestquote.
const LINES_OFF = new Set([1.5]);
const lineOn = (line) => !LINES_OFF.has(line);

function computeConfidenceScore(parsed) {
  const model = CONFIDENCE_MODELS[parsed.targetLine];
  if (!model) return null;
  if (parsed.minute == null || parsed.totalSot == null || parsed.radar == null || parsed.goallinePre == null) {
    return null;
  }
  const x = [parsed.minute, parsed.totalSot, parsed.radar, parsed.goallinePre];
  let z = model.intercept;
  for (let i = 0; i < x.length; i++) {
    z += ((x[i] - model.mean[i]) / model.std[i]) * model.coef[i];
  }
  const proba = 1 / (1 + Math.exp(-z));
  return { proba, threshold: model.threshold, passes: proba >= model.threshold && lineOn(parsed.targetLine) };
}

// Trims a full signal card down to just the essentials for the premium
// channel: title, divider, league, match, target/progress, time, radar,
// strike rate. Drops the Live Stats and Market/odds blocks entirely.
function buildPremiumMessage(text, label) {
  const lines = text.split(/\r?\n/);
  const keepPatterns = [
    /🏆/, // league
    /Target:/i, // target + progress
    /\d+'[\s·•]+~?\d+\s*min left/i, // time
    /Radar X:/i,
    /Strike Rate:/i,
    /^[_\-─—=]{3,}$/, // divider lines
  ];
  const matchLinePattern = /^(?:📊|📖|⚽|🥅|🏟️|🆚|⚔️)?\s*.+?\s+\d+\s*[–-]\s*\d+\s+.+$/u;

  const firstIdx = lines.findIndex((l) => l.trim().length > 0);
  const kept = [];
  if (firstIdx !== -1) kept.push(lines[firstIdx]);
  for (let i = 0; i < lines.length; i++) {
    if (i === firstIdx || !lines[i].trim()) continue;
    const line = lines[i];
    if (keepPatterns.some((p) => p.test(line)) || matchLinePattern.test(line)) {
      kept.push(line);
    }
  }
  return `${label}\n\n${kept.join("\n")}`;
}

// Logs every premium-channel forward so it can later be cross-referenced
// against a fresh CSV export (same join fields analyze_signals.py uses:
// date, teams, signal minute) to check the model's real-world hit rate.
async function logPremiumForward(env, parsed, score, keyPrefix, extra = {}) {
  const now = new Date();
  const record = {
    date: now.toISOString().slice(0, 10),
    forwardedAt: now.toISOString(),
    targetLine: parsed.targetLine,
    homeTeam: parsed.homeTeam || null,
    awayTeam: parsed.awayTeam || null,
    minute: parsed.minute,
    totalSot: parsed.totalSot,
    radar: parsed.radar,
    goallinePre: parsed.goallinePre,
    feedWR: parsed.feedWR != null ? parsed.feedWR : null,
    modelProba: score ? Math.round(score.proba * 1000) / 1000 : null,
    threshold: score ? score.threshold : null,
    ...extra,
  };
  const key = `${keyPrefix}:${now.getTime()}:${randomToken().slice(0, 8)}`;
  await env.ACCESS_KV.put(key, JSON.stringify(record), { expirationTtl: 180 * 24 * 60 * 60 });
}

// ---------------------------------------------------------------------
// Live confirmation before posting to the premium channel. A card that
// clears the confidence threshold is not forwarded right away: it is
// queued, and the cron trigger (every minute) re-checks the match in the
// InPlayFlux live-scanner feed once it is at least CONFIRM_DELAY_MS old,
// using the same checks as scripts/live_radar.py (model, goal score, no goal
// yet, no red card, not late). Only if it still holds is it posted.
const PENDING_KEY = "premium:pending";
const CONFIRM_DELAY_MS = 2 * 60 * 1000;
const CONFIRM_GIVE_UP_MS = 4 * 60 * 1000; // match not found in the feed for this long -> post unchecked
// Since 2026-10-17 InPlayFlux serves guests only a preview of ~15 matches (the
// ones furthest into the game), so a card at minute 60 is usually not in it.
// A feed this small is treated as that preview: a card whose match is missing
// is posted unchecked right away instead of waiting for a match that won't show.
const GUEST_FEED_MAX = 20;
const GUEST_FEED_REASON = "Spiel nicht in der Gast-Vorschau des Live-Feeds";
const isGuestFeed = (feed) => Array.isArray(feed) && feed.length <= GUEST_FEED_MAX;

// Second source for the 2-minute check while InPlayFlux is only a guest preview:
// API-Football (api-sports.io), an official API with its own key (Cloudflare
// secret APIFOOTBALL_KEY; free plan 100 calls/day, one call per minute only while
// cards wait). It has minute, score and red cards for nearly all leagues, but no
// shots on target, radar or market line, so it only checks "no goal, no red card,
// not too late". Without the key cards are posted unchecked as before.
const APIFOOTBALL_LIVE_URL = "https://v3.football.api-sports.io/fixtures?live=all";

async function fetchApiFootballLive(env) {
  if (!env.APIFOOTBALL_KEY) return null;
  try {
    const resp = await fetch(APIFOOTBALL_LIVE_URL, {
      headers: { "x-apisports-key": env.APIFOOTBALL_KEY },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    // Quota or key problems come back as HTTP 200 with an "errors" object.
    const errors = data && data.errors;
    if (!data || !Array.isArray(data.response) || (errors && Object.keys(errors).length)) return null;
    return data.response.map((f) => {
      const gh = num(f.goals && f.goals.home) || 0;
      const ga = num(f.goals && f.goals.away) || 0;
      const events = Array.isArray(f.events) ? f.events : null;
      return {
        h: f.teams && f.teams.home && f.teams.home.name,
        a: f.teams && f.teams.away && f.teams.away.name,
        minute: num(f.fixture && f.fixture.status && f.fixture.status.elapsed),
        goals: gh + ga,
        score: `${gh}-${ga}`,
        redCards: events ? events.filter((e) => e.type === "Card" && /red/i.test(e.detail || "")).length : null,
      };
    });
  } catch (e) {
    return null;
  }
}

// The checks of confirmLive that API-Football can answer.
function confirmBasic(item, m) {
  const goalsAtSignal = item.parsed.targetLine - 0.5;
  const live = { source: "api-football", minute: m.minute, score: m.score, redCards: m.redCards };
  if (m.minute == null) return { ok: false, unknown: true, live };
  if (m.goals > goalsAtSignal) return { ok: false, reason: `Tor schon gefallen (${m.score})`, live };
  if (m.redCards > 0) return { ok: false, reason: "Rote Karte", live };
  if (m.minute >= RISK_MINUTE) return { ok: false, reason: `zu spät (${m.minute}')`, live };
  return { ok: true, live };
}
const FEED_URL = "https://inplayflux.com/maclarv8/GETAllMatches.php?inplay=inplay&v=";
const RISK_MINUTE = 70;
// The model docks every minute, so re-scoring at the later live minute pushed
// many cards just under the threshold for no change in the game. Backtest
// (reports/2026-10-06-premium-channel.md): a 5 pp tolerance keeps the same
// ~81% hit rate with almost twice the posts.
const CONFIRM_TOLERANCE = 0.05;
// Risk tier: only late cards that historically hold up (reports/2026-10-06-premium-channel.md):
// minute >= 72 or Radar >= 410 -> 64.8% vs 55.9% for the rest.
// Risiko tier switched off 2026-10-13 at the owner's request: 8/20 on
// 06-10.10 and 4/9 in the week to 13.10 (backtest 62.8%). Set to true to
// post Risiko cards again.
const RISK_ENABLED = false;
const RISK_MIN_MINUTE = 72;
const RISK_MIN_RADAR = 410;
// Risk tier hit rate after the minute/radar filter (backtest 2026-10-06), used
// for its minimum quote.
// Recalibrated 2026-10-10: 62.8% (n=258; the new days alone 8/20).
const RISK_WR = 0.628;
// Stake advice in units, by expected hit rate.
const UNITS_STRONG = 2; // goal score >= +1 (historically ~82%)
const UNITS_NORMAL = 1;
const UNITS_RISK = 0.5;
// Half-Risiko tier: cards at minute 68-69 below the confidence threshold,
// only when the live goal score is >= -7 (backtest 2026-10-07: 66.3%, n=172,
// both halves 62% / 75%; the rest at 68-69 only 51.8%). Needs the live feed
// for the goal score; without it the card is skipped.
const HALF_MIN_MINUTE = 68;
const HALF_MIN_GOAL_POINTS = -7;
// Recalibrated 2026-10-10 with the refit goal score: 65.0% (n=183).
const HALF_WR = 0.65;
const UNITS_HALF = 0.5;
// "Over 1.5 Test" (since 2026-10-21, owner's call): the O1.5 model stays off
// (LINES_OFF, 71% on the unseen days), but the simple rule minute <= 61 and
// pre-match line >= 2.75 gave 76.1% (n=522, halves 80.9/73.0) and 75.8% on
// the unseen days 17.-21.10. (n=91). Half stake, own tier in the results;
// queued by the webhook, posted by the next minute run (no goal or red card
// since the card if the match is in the feed). Re-check at >= 100 live tips.
const O15_TEST_ENABLED = true;
const O15_MAX_MINUTE = 61;
const O15_MIN_LINE_PRE = 2.75;
const O15_WR = 0.76;
const o15TestRule = (parsed) => O15_TEST_ENABLED && parsed.targetLine === 1.5 &&
  parsed.minute != null && parsed.minute <= O15_MAX_MINUTE &&
  parsed.goallinePre != null && parsed.goallinePre >= O15_MIN_LINE_PRE;
// "Under 3.5 – mit Vorsicht setzen": O2.5 cards (2 goals) that are not
// premium and whose live goal score is low. Rule since 2026-10-16 from the
// strict shadow log (11.-16.10., 85'+ rule): goal score <= 0 and live line
// <= 3.5 -> 15/22 = 68% for non-premium cards (old rule <= -3 at line exactly
// 3.5 never fired). Only at line 3.5 is the feed's under quote the real
// Under 3.5 quote, so it must clear the minimum quote; at lower lines the
// post asks to check the Under 3.5 quote at the bookmaker. Small stake;
// re-check at >= 100 strict games.
// Paused 2026-10-21 by the owner until the rule is recalculated; the shadow
// log (logUnder35) keeps running so the new numbers can be computed.
const UNDER_ENABLED = false;
const UNDER_MAX_GOAL_POINTS = 0;
const UNDER_MAX_LINE = 3.5;
const UNDER_WR = 0.68;
const UNITS_UNDER = 0.5;
// Result tracking of posted signals.
const TRACK_KEY = "track:open";
const TRACK_LOST_AFTER_MIN = 85;      // match last seen at 85'+ and then gone -> no more goal
const TRACK_MISSING_GRACE_MS = 10 * 60 * 1000;
const TRACK_GIVE_UP_MS = 4 * 60 * 60 * 1000; // never seen late -> void after 4 h
const WEEKLY_CRON = "0 8 * * 1";       // Monday 08:00 UTC
const RADAR_MARKET_BONUS = 124.7;

// Mirror of calibration/goal_score.json (generated by scripts/goal_drivers.py).
const GOAL_SCORE = {
  minPremium: -2,
  points: {
    min_58_62: -2, min_63_65: -4, min_66p: -8, line_lo: -2, line_hi: 2, ht_hi: 1,
    def_strong: -1, sot9: 2, recent_goal: -1, over_odds_hi: -1, fav_up1: -1,
  },
  bands: [
    { min: -99, max: -9, wr: 0.551 },
    { min: -8, max: -6, wr: 0.634 },
    { min: -5, max: -3, wr: 0.701 },
    { min: -2, max: 0, wr: 0.749 },
    { min: 1, max: 99, wr: 0.809 },
  ],
};

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function pairSum(v) {
  if (!Array.isArray(v) || v.length < 2) return null;
  const a = num(v[0]);
  const b = num(v[1]);
  return a == null || b == null ? null : a + b;
}

function normTeam(name) {
  return String(name || "").toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "");
}

function findMatch(feed, homeTeam, awayTeam) {
  const h = normTeam(homeTeam);
  const a = normTeam(awayTeam);
  if (!h || !a) return null;
  return (
    feed.find((m) => normTeam(m.h) === h && normTeam(m.a) === a) ||
    feed.find((m) => {
      const mh = normTeam(m.h);
      const ma = normTeam(m.a);
      return (mh.includes(h) || h.includes(mh)) && (ma.includes(a) || a.includes(ma));
    }) ||
    null
  );
}

// Since 2026-10-07 the feed needs a short-lived X-IR-Token bound to a session
// cookie. The scanner page hands out both on a HEAD request with
// ?ir_token_refresh=1 (the same call the page itself makes every 4 minutes).
// Kept per isolate and renewed after FEED_TOKEN_TTL_MS or on a 403.
const SCANNER_URL = "https://inplayflux.com/live-scanner?page=open&lang=en";
const FEED_TOKEN_TTL_MS = 8 * 60 * 1000;
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
let feedSession = null; // { token, cookie, at }

async function refreshFeedSession() {
  try {
    const resp = await fetch(SCANNER_URL + "&ir_token_refresh=1", {
      method: "HEAD",
      headers: { "User-Agent": BROWSER_UA },
      signal: AbortSignal.timeout(8000),
    });
    const token = resp.headers.get("X-IR-Token");
    const setCookies = typeof resp.headers.getSetCookie === "function"
      ? resp.headers.getSetCookie()
      : [resp.headers.get("Set-Cookie") || ""];
    const cookie = setCookies.map((c) => c.split(";")[0].trim()).filter(Boolean).join("; ");
    feedSession = token && /^[a-f0-9]{64}$/i.test(token) ? { token, cookie, at: Date.now() } : null;
  } catch (e) {
    feedSession = null;
  }
  return feedSession;
}

async function fetchFeedOnce(session) {
  const headers = {
    "User-Agent": BROWSER_UA,
    Referer: SCANNER_URL,
    "X-Requested-With": "XMLHttpRequest",
  };
  if (session) {
    headers["X-IR-Token"] = session.token;
    if (session.cookie) headers.Cookie = session.cookie;
  }
  const resp = await fetch(FEED_URL + Date.now(), { headers, signal: AbortSignal.timeout(8000) });
  if (!resp.ok) return { ok: false, status: resp.status };
  const data = await resp.json();
  return Array.isArray(data) ? { ok: true, data } : { ok: false, status: 403 };
}

async function fetchFeed() {
  try {
    let session = feedSession && Date.now() - feedSession.at < FEED_TOKEN_TTL_MS ? feedSession : await refreshFeedSession();
    let res = await fetchFeedOnce(session);
    if (!res.ok && (res.status === 401 || res.status === 403)) {
      session = await refreshFeedSession();
      res = await fetchFeedOnce(session);
    }
    return res.ok ? res.data : null;
  } catch (e) {
    return null;
  }
}

// Live over/under quote as InPlayFlux shows it: the market's main live goal
// line, which is not always the signal's target line - so the line is logged
// with it, and only quotes where line == target line are exact for the bet.
function oddsSnapshot(m) {
  if (!m) return null;
  const ou = m.ou_odds || [];
  const over = num(ou[0]);
  if (!over) return null;
  return {
    over,
    under: num(ou[1]),
    line: num(ou[2]),
    minute: num(m.minute),
    score: `${num(m.hg) || 0}-${num(m.ag) || 0}`,
    at: new Date().toISOString(),
  };
}

// One premium post per match and target line. InPlayFlux sometimes sends a
// card twice (or edits it, which arrives as edited_channel_post); without
// this the premium channel got the same signal twice and the tracking
// counted it twice. Returns false if this match/line was already claimed.
const CLAIM_TTL_S = 3 * 60 * 60;
async function claimSignal(env, parsed) {
  const h = normTeam(parsed.homeTeam);
  const a = normTeam(parsed.awayTeam);
  if (!h || !a) return true;
  const key = `claim:${h}:${a}:${parsed.targetLine}`;
  if (await env.ACCESS_KV.get(key)) return false;
  await env.ACCESS_KV.put(key, "1", { expirationTtl: CLAIM_TTL_S });
  return true;
}

// Half-Risiko: minute 68-69 card below the threshold. Posted right away, but
// only if the match is in the live feed, no goal or red card came since the
// card, and the goal score clears HALF_MIN_GOAL_POINTS.
// Every decision is logged (half:ok / half:rej) and shows up in the admin
// panel next to the premium confirmations.
async function maybePostHalfRisk(env, text, parsed, score) {
  const snap = await signalSnapshotFor(parsed);
  const odds = snap.odds;
  const item = { id: randomToken().slice(0, 12), parsed, proba: score ? score.proba : null, signalOdds: odds, receivedAt: Date.now() };
  const reject = async (reason, extra = {}) => {
    await logConfirmation(env, item, { tier: "half", reason, ...extra }, "half:rej");
    return false;
  };
  if (!snap.match) return reject("Spiel nicht im Live-Feed");
  const live = liveSnapshot(snap.match);
  const market = marketProb(snap.match, parsed.targetLine);
  if (live.goals > parsed.targetLine - 0.5) return reject(`Tor schon gefallen (${live.score})`, { live });
  if (live.redCards > 0) return reject("Rote Karte", { live, market });
  const gs = goalScore({ ...live, minute: live.minute != null ? live.minute : parsed.minute });
  if (gs.points < HALF_MIN_GOAL_POINTS) return reject(`Tor-Score ${gs.points} < ${HALF_MIN_GOAL_POINTS}`, { live, goal: gs, market });
  if (!(await claimSignal(env, parsed))) return false; // already posted for this match and line
  const mq = minQuote(HALF_WR);
  const probaNote = score ? ` · Modell: ${Math.round(score.proba * 100)}%` : "";
  const post = await postPremium(env, buildPremiumMessage(text, `🟠 Half-Risiko-Signal (Minute ${parsed.minute}' · Tor-Score ${gs.points}${probaNote}${market != null ? ` · Markt ${Math.round(market * 100)}%` : ""})`) +
      (odds ? `\nQuote: ${oddsText(odds)}` : "") + "\n\n" +
      stakeAdvice(parsed.targetLine, mq, UNITS_HALF, odds));
  await trackSignal(env, {
    ...post,
    tier: "half", home: parsed.homeTeam, away: parsed.awayTeam, matchId: snap.matchId,
    line: parsed.targetLine, minute: parsed.minute, minQuote: mq, units: UNITS_HALF, odds,
  });
  await logPremiumForward(env, parsed, score, "half:fwd", { signalOdds: odds, postOdds: odds, goalPoints: gs.points, marketProba: market });
  await logConfirmation(env, item, { tier: "half", live, goal: gs, postOdds: odds, market }, "half:ok");
  return true;
}

// Live main line must be <= 3.5. At exactly 3.5 the feed's under quote is the
// Under 3.5 quote and must clear the minimum quote; below 3.5 the feed has no
// Under 3.5 quote (it is lower than the main-line under), so the post asks
// the reader to check it.
function underOddsOk(odds, mq) {
  if (!odds || odds.line == null || odds.line > UNDER_MAX_LINE) return false;
  if (odds.line === 3.5) return !!odds.under && odds.under >= mq;
  return true;
}

function underQuoteLine(odds) {
  return odds && odds.line === 3.5 && odds.under
    ? `Quote: Under 3.5 @ ${odds.under.toFixed(2)}`
    : `Live-Linie ${String(odds.line).replace(".", ",")} – Under-3.5-Quote bitte beim Buchmacher prüfen`;
}

// Posts an Under 3.5 tip for an O2.5 card when the conditions above hold.
async function maybePostUnder35(env, text, parsed, score) {
  if (!UNDER_ENABLED) return false;
  if (parsed.targetLine !== 2.5 || (score && score.passes)) return false;
  const snap = await signalSnapshotFor(parsed);
  if (!snap.match) return false;
  const live = liveSnapshot(snap.match);
  if (live.goals !== 2 || live.redCards > 0) return false;
  const gs = goalScore({ ...live, minute: live.minute != null ? live.minute : parsed.minute }).points;
  if (gs > UNDER_MAX_GOAL_POINTS) return false;
  const wr = UNDER_WR;
  const mq = minQuote(wr);
  const odds = snap.odds;
  if (!underOddsOk(odds, mq)) return false;
  if (!(await claimSignal(env, { ...parsed, targetLine: "u3.5" }))) return false;
  const keep = text.split(/\r?\n/).filter((l) =>
    /🏆/.test(l) || /\d+'[\s·•]+~?\d+\s*min left/i.test(l) || /Radar X:/i.test(l) ||
    (/^(?:📊|📖|⚽|🥅|🏟️|🆚|⚔️)?\s*.+?\s+\d+\s*[–-]\s*\d+\s+.+$/u.test(l) && !/→|moneybag/i.test(l)));
  const signed = gs > 0 ? `+${gs}` : String(gs);
  const msg = [
    `🛡️ Under 3.5 Tore – mit Vorsicht setzen (Tor-Score ${signed} · Live-Log ${Math.round(wr * 100)}%)`,
    "",
    ...keep,
    "🎯 Tipp: Under 3.5 Tore (gewinnt, wenn höchstens noch 1 Tor fällt)",
    underQuoteLine(odds),
    "",
    `💶 Nur setzen ab Quote ${fmtQuote(mq)} (Under 3.5) · Einsatz: ${String(UNITS_UNDER).replace(".", ",")} Einheiten`,
  ].join("\n");
  const post = await postPremium(env, msg);
  await trackSignal(env, {
    ...post,
    tier: "under", under: true, home: parsed.homeTeam, away: parsed.awayTeam, matchId: snap.matchId,
    line: 3.5, minute: parsed.minute, minQuote: mq, units: UNITS_UNDER, odds,
  });
  await logPremiumForward(env, { ...parsed, targetLine: 3.5 }, score, "under:fwd", {
    signalOdds: odds, postOdds: odds, goalPoints: gs,
  });
  return true;
}


async function signalSnapshotFor(parsed) {
  const feed = await fetchFeed();
  const match = Array.isArray(feed) ? findMatch(feed, parsed.homeTeam, parsed.awayTeam) : null;
  return { odds: oddsSnapshot(match), matchId: match ? match.id : null, match, guestFeed: isGuestFeed(feed) };
}

function oddsText(o) {
  return o ? `Over ${o.line != null ? o.line + " " : ""}@ ${o.over.toFixed(2)}` : null;
}

function liveSnapshot(m) {
  const ou = m.ou_odds || [];
  const minute = num(m.minute);
  const goalsH = num(m.hg) || 0;
  const goalsA = num(m.ag) || 0;
  const overOdds = num(ou[0]);
  const underOdds = num(ou[1]);
  const lastGoal = num(m.sonGolDakikasi) || 0;
  const ko = m.p_odds || [];
  let favMargin = null;
  if (num(ko[0]) && num(ko[2])) {
    favMargin = num(ko[0]) < num(ko[2]) ? goalsH - goalsA : goalsA - goalsH;
  }
  return {
    minute,
    goals: goalsH + goalsA,
    score: `${goalsH}-${goalsA}`,
    sot: pairSum(m.so),
    radar: num(m.xg),
    goallinePre: num(m.p_goal),
    htLinePre: num(m.p_goal_h),
    avgConc: pairSum(m.p_avg_g_c),
    sinceGoal: minute == null ? null : minute - lastGoal,
    favMargin,
    overFav: !!(overOdds && underOdds && overOdds < underOdds),
    overOdds,
    liveLine: num(ou[2]),
    redCards: (num(m.hrc) || 0) + (num(m.arc) || 0),
  };
}

// Market probability for one more goal (target line), from the feed's live
// main O/U line and its odds: margin removed, then the remaining-goals Poisson
// lambda solved so the over price matches (whole lines push, quarter lines
// split the stake). Same maths as step 3b in the analyst tool.
// Veto for premium: the exports carry no live line, so this could not be
// backtested; the cut is deliberately low and only drops cards the market
// clearly disagrees with. Every decision logs marketProba for calibration.
const MARKET_MIN_PREMIUM = 0.6;

function poissonPmf(k, l) {
  let p = Math.exp(-l);
  for (let i = 1; i <= k; i++) p *= l / i;
  return p;
}
function poissonTail(k, l) {
  if (k <= 0) return 1;
  let cdf = 0;
  for (let i = 0; i < k; i++) cdf += poissonPmf(i, l);
  return Math.max(0, 1 - cdf);
}
function overLineProb(line, l) {
  const frac = Math.round((line - Math.floor(line)) * 100) / 100;
  if (frac === 0.25 || frac === 0.75) return (overLineProb(line - 0.25, l) + overLineProb(line + 0.25, l)) / 2;
  if (frac === 0) {
    const push = poissonPmf(line, l);
    return push >= 1 ? 0 : poissonTail(line + 1, l) / (1 - push);
  }
  return poissonTail(Math.floor(line) + 1, l);
}
// Remaining-goals Poisson lambda implied by the feed's live main O/U line.
function marketLambda(match) {
  if (!match) return null;
  const ou = match.ou_odds || [];
  const over = num(ou[0]);
  const under = num(ou[1]);
  const line = num(ou[2]);
  if (!over || !under || line == null) return null;
  const goals = (num(match.hg) || 0) + (num(match.ag) || 0);
  const rest = line - goals;
  if (rest <= 0) return null;
  const pFair = (1 / over) / (1 / over + 1 / under);
  let lo = 0;
  let hi = 20;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (overLineProb(rest, mid) < pFair) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function marketProb(match, targetLine) {
  if (!match || targetLine == null) return null;
  const lambda = marketLambda(match);
  if (lambda == null) return null;
  const goals = (num(match.hg) || 0) + (num(match.ag) || 0);
  const p = poissonTail(Math.floor(targetLine - goals) + 1, lambda);
  return Math.round(p * 1000) / 1000;
}

// ---------------------------------------------------------------------
// Under 3.5 shadow log: every O2.5 card (2 goals) is logged without any
// post, with the feed's live line and odds, to check whether Under 3.5 (at
// most one more goal) pays (reports: Under 3.5 hits ~64% after O2.5
// signals, break-even quote ~1.56; the real quotes are unknown).
// KV: one key per UTC day ("u35:YYYY-MM-DD", array of entries). A card adds
// one write; the cron only writes when a 4th goal turns an entry lost.
// "Won" is derived when read: no 4th goal seen until the match is over.
const U35_PREFIX = "u35:";
const U35_TTL_S = 180 * 24 * 60 * 60;
const U35_WATCH_MIN = 110; // watch until about signal + (110 - minute) min

function u35Key(ms) {
  return U35_PREFIX + new Date(ms).toISOString().slice(0, 10);
}

async function readU35(env, key) {
  const raw = await env.ACCESS_KV.get(key);
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

function u35Deadline(e) {
  return e.at + Math.max(15, U35_WATCH_MIN - (e.minute || 60)) * 60 * 1000;
}

// Minute from which a match counts as watched to the end: an entry is only
// "won" if the feed showed the match at U35_SEEN_LATE_MIN or later without a
// 4th goal; otherwise a match that dropped out of the feed early could hide
// a late goal ("unclear"). Entries logged before this check (no v: 2) keep
// the old rule.
const U35_SEEN_LATE_MIN = 85;

function u35Status(e, now) {
  if (e.lostAt) return "lost";
  if (!e.matchId || (e.goals != null && e.goals !== 2)) return "void";
  if (now < u35Deadline(e)) return "open";
  if (e.v === 2 && !e.seenLate) return "unclear";
  return "won";
}

async function logUnder35(env, parsed, score) {
  if (parsed.targetLine !== 2.5) return;
  const feed = await fetchFeed();
  const match = Array.isArray(feed) ? findMatch(feed, parsed.homeTeam, parsed.awayTeam) : null;
  const now = Date.now();
  const key = u35Key(now);
  const [today, before] = await Promise.all([readU35(env, key), readU35(env, u35Key(now - DAY_MS))]);
  const same = (e) =>
    (match && e.matchId === match.id) ||
    (normTeam(e.home) === normTeam(parsed.homeTeam) && normTeam(e.away) === normTeam(parsed.awayTeam));
  if (today.some(same) || before.some((e) => same(e) && now - e.at < 4 * 60 * 60 * 1000)) return;
  const ou = match ? match.ou_odds || [] : [];
  const lambda = marketLambda(match);
  const goals = match ? (num(match.hg) || 0) + (num(match.ag) || 0) : null;
  // Goal score at the card: low scores favour Under 3.5 (backtest: <= -6
  // ~82%, >= +1 ~56%).
  let gs = null;
  if (match) {
    const live = liveSnapshot(match);
    gs = goalScore({ ...live, minute: live.minute != null ? live.minute : parsed.minute }).points;
  }
  const entry = {
    id: randomToken().slice(0, 10),
    at: now,
    home: parsed.homeTeam || null,
    away: parsed.awayTeam || null,
    matchId: match ? match.id : null,
    minute: parsed.minute,
    liveMinute: match ? num(match.minute) : null,
    goals,
    line: num(ou[2]),
    over: num(ou[0]),
    under: num(ou[1]),
    // Market chance of at most one more goal (= Under 3.5 at 2 goals).
    marketU35: lambda != null && goals === 2 ? Math.round(Math.exp(-lambda) * (1 + lambda) * 1000) / 1000 : null,
    premium: !!(score && score.passes),
    proba: score ? Math.round(score.proba * 1000) / 1000 : null,
    gs,
    v: 2,
  };
  today.push(entry);
  await env.ACCESS_KV.put(key, JSON.stringify(today), { expirationTtl: U35_TTL_S });
}

async function settleU35(env, feed, lists) {
  if (!Array.isArray(feed)) return;
  const now = Date.now();
  for (const [key, list] of lists) {
    const lost = {};
    for (const e of list) {
      if (u35Status(e, now) !== "open") continue;
      const m = feed.find((x) => x.id === e.matchId);
      if (!m) continue;
      const goals = (num(m.hg) || 0) + (num(m.ag) || 0);
      const minute = num(m.minute);
      if (goals >= 4) lost[e.id] = { lostAt: now, lostMinute: minute, finalGoals: goals };
      // One extra write per card: remember that the match was seen late.
      else if (!e.seenLate && minute != null && minute >= U35_SEEN_LATE_MIN) lost[e.id] = { seenLate: minute };
    }
    if (!Object.keys(lost).length) continue;
    // Re-read so a card the webhook added meanwhile is not overwritten.
    const latest = await readU35(env, key);
    for (const e of latest) if (lost[e.id]) Object.assign(e, lost[e.id]);
    await env.ACCESS_KV.put(key, JSON.stringify(latest), { expirationTtl: U35_TTL_S });
  }
}

async function u35Rows(env, days) {
  const now = Date.now();
  const keys = [];
  for (let d = 0; d < days; d++) keys.push(u35Key(now - d * DAY_MS));
  const lists = await Promise.all(keys.map((k) => readU35(env, k)));
  return lists.flat().map((e) => ({ ...e, status: u35Status(e, now) })).sort((a, b) => b.at - a.at);
}

function u35Summary(rows) {
  const decided = rows.filter((r) => r.status === "won" || r.status === "lost");
  const part = (list) => {
    const won = list.filter((r) => r.status === "won").length;
    const priced = list.filter((r) => r.line === 3.5 && r.under);
    const profit = priced.reduce((a, r) => a + (r.status === "won" ? r.under - 1 : -1), 0);
    const mk = list.filter((r) => r.marketU35 != null);
    return {
      n: list.length,
      won,
      rate: list.length ? Math.round((won / list.length) * 1000) / 1000 : null,
      marketAvg: mk.length ? Math.round((mk.reduce((a, r) => a + r.marketU35, 0) / mk.length) * 1000) / 1000 : null,
      line35: priced.length,
      underAvg35: priced.length ? Math.round((priced.reduce((a, r) => a + r.under, 0) / priced.length) * 100) / 100 : null,
      profit35: Math.round(profit * 100) / 100,
    };
  };
  const withGs = decided.filter((r) => r.gs != null);
  return {
    all: part(decided),
    nonPremium: part(decided.filter((r) => !r.premium)),
    premium: part(decided.filter((r) => r.premium)),
    // Backtest hit rates per band, for comparison with the live quotes.
    byGoalScore: [
      { label: "≤ −6", min: -99, max: -6, backtest: 0.82 },
      { label: "−5 … −3", min: -5, max: -3, backtest: 0.687 },
      { label: "−2 … 0", min: -2, max: 0, backtest: 0.637 },
      { label: "≥ +1", min: 1, max: 99, backtest: 0.556 },
    ].map((b) => ({ ...b, ...part(withGs.filter((r) => r.gs >= b.min && r.gs <= b.max)) })),
    open: rows.filter((r) => r.status === "open").length,
    void: rows.filter((r) => r.status === "void").length,
    unclear: rows.filter((r) => r.status === "unclear").length,
  };
}

// Same conditions as goal_score_conditions() in scripts/live_radar.py.
function goalScore(s) {
  const c = {
    min_58_62: s.minute >= 58 && s.minute <= 62,
    min_63_65: s.minute >= 63 && s.minute <= 65,
    min_66p: s.minute >= 66,
    line_lo: s.goallinePre != null && s.goallinePre <= 2.5,
    line_hi: s.goallinePre != null && s.goallinePre >= 3.25,
    ht_hi: s.htLinePre != null && s.htLinePre >= 1.5,
    def_strong: s.avgConc != null && s.avgConc <= 2.2,
    sot9: (s.sot || 0) >= 9,
    recent_goal: s.sinceGoal != null && s.sinceGoal <= 5,
    over_odds_hi: s.overOdds != null && s.overOdds > 2.03,
    fav_up1: s.favMargin === 1,
  };
  let points = 0;
  for (const [k, on] of Object.entries(c)) if (on) points += GOAL_SCORE.points[k];
  const band = GOAL_SCORE.bands.find((b) => points >= b.min && points <= b.max);
  return { points, wr: band ? band.wr : null };
}

// Returns { ok, reason, live, score, goal } for a queued signal.
function confirmLive(item, match) {
  const s = liveSnapshot(match);
  const goalsAtSignal = item.parsed.targetLine - 0.5;
  if (s.minute == null) return { ok: false, reason: "keine Live-Minute im Feed", live: s };
  if (s.goals > goalsAtSignal) return { ok: false, reason: `Tor schon gefallen (${s.score})`, live: s };
  if (s.redCards > 0) return { ok: false, reason: "Rote Karte", live: s };
  if (s.minute >= RISK_MINUTE) return { ok: false, reason: `zu spät (${s.minute}')`, live: s };
  const score = computeConfidenceScore({
    targetLine: item.parsed.targetLine,
    minute: s.minute,
    totalSot: s.sot,
    radar: s.radar,
    goallinePre: s.goallinePre != null ? s.goallinePre : item.parsed.goallinePre,
  });
  if (!score) return { ok: false, reason: "Modell nicht berechenbar", live: s };
  if (score.proba < score.threshold - CONFIRM_TOLERANCE) {
    return { ok: false, reason: `Modell ${Math.round(score.proba * 100)}% < ${Math.round((score.threshold - CONFIRM_TOLERANCE) * 100)}%`, live: s, score };
  }
  const goal = goalScore(s);
  const market = marketProb(match, item.parsed.targetLine);
  if (goal.points < GOAL_SCORE.minPremium) {
    return { ok: false, reason: `Tor-Score ${goal.points}`, live: s, score, goal, market };
  }
  if (market != null && market < MARKET_MIN_PREMIUM) {
    return { ok: false, reason: `Markt ${Math.round(market * 100)}% < ${Math.round(MARKET_MIN_PREMIUM * 100)}%`, live: s, score, goal, market };
  }
  return { ok: true, live: s, score, goal, market };
}

function confirmationBlock(res) {
  const s = res.live;
  const signed = (n) => (n > 0 ? `+${n}` : String(n));
  const lines = [
    "",
    `✅ Live bestätigt nach 2 min: ${s.minute}' · ${s.score}`,
    `Modell ${Math.round(res.score.proba * 100)}% · Tor-Score ${signed(res.goal.points)} (${Math.round(res.goal.wr * 100)}%)` +
      (res.market != null ? ` · Markt ${Math.round(res.market * 100)}%` : ""),
  ];
  const radarNote = s.radar != null ? `Radar ${Math.round(s.radar)}${s.overFav ? ` (davon Markt +${Math.round(RADAR_MARKET_BONUS)})` : ""}` : null;
  const oddsNote = res.postOdds ? oddsText(res.postOdds) + (res.signalOdds ? ` (bei Signal ${res.signalOdds.over.toFixed(2)})` : "") : null;
  const extra = [radarNote, s.sot != null ? `SoT ${s.sot}` : null, oddsNote].filter(Boolean);
  if (extra.length) lines.push(extra.join(" · "));
  return lines.join("\n");
}

async function readPending(env) {
  const raw = await env.ACCESS_KV.get(PENDING_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch (e) {
    return [];
  }
}

function premiumItem(text, parsed, score, signalOdds) {
  return { id: randomToken().slice(0, 12), text, parsed, proba: score ? score.proba : null, signalOdds, receivedAt: Date.now() };
}

// Same tip = same tier, match and line (normalised team names).
function tipKey(tier, home, away, line) {
  return `${tier}|${normTeam(home)}|${normTeam(away)}|${line}`;
}

async function queuePremium(env, text, parsed, score, signalOdds, fast = false, tier = "premium") {
  const pending = await readPending(env);
  pending.push({ ...premiumItem(text, parsed, score, signalOdds), fast, tier });
  await env.ACCESS_KV.put(PENDING_KEY, JSON.stringify(pending), { expirationTtl: 24 * 60 * 60 });
}

async function logConfirmation(env, item, res, keyPrefix) {
  const now = new Date();
  const record = {
    date: now.toISOString().slice(0, 10),
    decidedAt: now.toISOString(),
    queuedAt: new Date(item.receivedAt).toISOString(),
    targetLine: item.parsed.targetLine,
    homeTeam: item.parsed.homeTeam || null,
    awayTeam: item.parsed.awayTeam || null,
    signalMinute: item.parsed.minute,
    signalProba: item.proba != null ? Math.round(item.proba * 1000) / 1000 : null,
    tier: res.tier || "premium",
    reason: res.reason || null,
    live: res.live || null,
    liveProba: res.score ? Math.round(res.score.proba * 1000) / 1000 : null,
    goalPoints: res.goal ? res.goal.points : null,
    marketProba: res.market != null ? res.market : null,
    signalOdds: item.signalOdds || null,
    postOdds: res.postOdds || null,
  };
  await env.ACCESS_KV.put(`${keyPrefix}:${now.getTime()}:${item.id}`, JSON.stringify(record), {
    expirationTtl: 180 * 24 * 60 * 60,
  });
}

// Runs every minute: confirms queued cards, then settles tracked ones. The
// feed is fetched at most once, and only when either job has work.
async function runMinuteJobs(env) {
  const now = Date.now();
  const u35Keys = [u35Key(now), u35Key(now - DAY_MS)];
  const [pending, tracked, ...u35Lists] = await Promise.all([
    readPending(env), readTracked(env), ...u35Keys.map((k) => readU35(env, k)),
  ]);
  const due = pending.filter((p) => p.fast || now - p.receivedAt >= CONFIRM_DELAY_MS);
  const u35Open = u35Lists.some((l) => l.some((e) => u35Status(e, now) === "open"));
  if (!due.length && !tracked.length && !u35Open) return; // the common case: KV reads only, no fetch, no writes
  // A slow feed can make one minute's run overlap the next. Both would then
  // post the same queued card and settle the same tip twice (seen 14.10.:
  // Aston Villa U19 twice in premium, results and the free channel). Only one
  // run at a time does the work; the lock expires on its own if a run dies.
  const lock = await env.ACCESS_KV.get(RUN_LOCK_KEY);
  if (lock && now - Number(lock) < RUN_LOCK_MS) return;
  await env.ACCESS_KV.put(RUN_LOCK_KEY, String(now), { expirationTtl: 120 });
  try {
    const feed = await fetchFeed();
    if (due.length) await processPendingPremium(env, due, feed);
    if (tracked.length) await settleTracked(env, feed);
    if (u35Open) await settleU35(env, feed, u35Keys.map((k, i) => [k, u35Lists[i]]));
  } finally {
    await env.ACCESS_KV.delete(RUN_LOCK_KEY);
  }
}

const RUN_LOCK_KEY = "lock:minute";
const RUN_LOCK_MS = 110 * 1000;

async function postUnchecked(env, item, reason, label) {
  const mq = minQuote(item.proba);
  // No "ohne Live-Prüfung" suffix since 17.10.: without a live source it was on every post (owner's call).
  label = label || `🔥 High Confidence (${Math.round(item.proba * 100)}%)`;
  const post = await postPremium(env, buildPremiumMessage(item.text, label) + "\n\n" +
      stakeAdvice(item.parsed.targetLine, mq, UNITS_NORMAL, item.signalOdds));
  await logPremiumForward(env, item.parsed, { proba: item.proba, threshold: null }, "premium:fwd", {
    signalOdds: item.signalOdds || null,
    unchecked: reason,
  });
  await logConfirmation(env, item, { reason: `ohne Prüfung gepostet: ${reason}` }, "premium:ok");
  await trackSignal(env, {
    ...post,
    tier: "premium", home: item.parsed.homeTeam, away: item.parsed.awayTeam, matchId: null,
    line: item.parsed.targetLine, minute: item.parsed.minute, minQuote: mq, units: UNITS_NORMAL, odds: item.signalOdds || null,
  });
}

// Over 1.5 Test: posted at the next minute run. If the match is in the feed,
// a goal or red card since the card rejects it; otherwise it is posted as is
// (the guest feed rarely shows matches at minute ~60).
async function postO15Test(env, item, match) {
  const p = item.parsed;
  let odds = item.signalOdds || null;
  let live = null;
  if (match) {
    live = liveSnapshot(match);
    odds = oddsSnapshot(match) || odds;
    const reason = live.goals > p.targetLine - 0.5 ? `Tor schon gefallen (${live.score})` : live.redCards > 0 ? "Rote Karte" : null;
    if (reason) return logConfirmation(env, item, { tier: "o15", reason, live }, "o15:rej");
  }
  const mq = minQuote(O15_WR);
  const label = `🧪 Over 1.5 Test (Minute ${p.minute}' · Vor-Spiel-Linie ${String(p.goallinePre).replace(".", ",")}${match ? " · live: kein Tor, keine Rote Karte" : ""})`;
  const post = await postPremium(env, buildPremiumMessage(item.text, label) +
      (odds ? `\nQuote: ${oddsText(odds)}` : "") + "\n\n" +
      "Testbetrieb seit 21.10.: Rückblick 76 % (522 Spiele), halber Einsatz.\n" +
      stakeAdvice(p.targetLine, mq, UNITS_HALF, odds));
  await trackSignal(env, {
    ...post,
    tier: "o15", home: p.homeTeam, away: p.awayTeam, matchId: match ? match.id || null : null,
    line: p.targetLine, minute: live && live.minute != null ? live.minute : p.minute, minQuote: mq, units: UNITS_HALF, odds,
  });
  await logPremiumForward(env, p, item.proba != null ? { proba: item.proba, threshold: null } : null, "o15:fwd", { signalOdds: item.signalOdds || null, postOdds: odds });
  await logConfirmation(env, item, { tier: "o15", live, postOdds: odds }, "o15:ok");
}

async function processPendingPremium(env, due, feed) {
  const now = Date.now();

  const done = new Set();
  let apiLive; // fetched at most once per run, only when a card needs it
  // One post per match and line: skip cards whose tip is already open or was
  // handled earlier in this run (several strategies send the same match).
  const seen = new Set((await readTracked(env)).filter((t) => t.tier === "premium" || t.tier === "o15").map((t) => tipKey(t.tier, t.home, t.away, t.line)));
  for (const item of due) {
    const tier = item.tier || "premium";
    const k = tipKey(tier, item.parsed.homeTeam, item.parsed.awayTeam, item.parsed.targetLine);
    if (seen.has(k)) {
      done.add(item.id);
      await logConfirmation(env, item, { tier, reason: "doppelt (gleiches Spiel und gleiche Linie schon gepostet)" }, `${tier}:rej`);
      continue;
    }
    seen.add(k);
    if (tier === "o15") {
      done.add(item.id);
      await postO15Test(env, item, Array.isArray(feed) ? findMatch(feed, item.parsed.homeTeam, item.parsed.awayTeam) : null);
      continue;
    }
    const match = Array.isArray(feed) ? findMatch(feed, item.parsed.homeTeam, item.parsed.awayTeam) : null;
    if (!match && env.APIFOOTBALL_KEY && (!Array.isArray(feed) || isGuestFeed(feed))) {
      if (apiLive === undefined) apiLive = await fetchApiFootballLive(env);
      const m = apiLive ? findMatch(apiLive, item.parsed.homeTeam, item.parsed.awayTeam) : null;
      const res = m ? confirmBasic(item, m) : null;
      if (res && res.ok) {
        done.add(item.id);
        await postUnchecked(env, item, "nur Tor/Rote Karte geprüft (API-Football)",
          `🔥 High Confidence (${Math.round(item.proba * 100)}%) · live geprüft: kein Tor, keine Rote Karte`);
      } else if (res && !res.unknown) {
        done.add(item.id);
        await logConfirmation(env, item, res, "premium:rej");
      } else if (!apiLive || now - item.receivedAt >= CONFIRM_GIVE_UP_MS) {
        // API down/quota used up, or the match is not found there either.
        done.add(item.id);
        await postUnchecked(env, item, apiLive ? "Spiel weder im Live-Feed noch bei API-Football" : "API-Football nicht erreichbar");
      }
      continue;
    }
    if (!match) {
      // A card that cleared the model must never be lost to an infrastructure
      // problem: with the feed down post it right away, with the match not
      // found keep retrying until CONFIRM_GIVE_UP_MS - then post it marked as
      // not live-checked (the old, pre-check behaviour, ~80% historically).
      const feedDown = !Array.isArray(feed);
      const guest = isGuestFeed(feed);
      if (feedDown || guest || now - item.receivedAt >= CONFIRM_GIVE_UP_MS) {
        done.add(item.id);
        const reason = feedDown ? "Live-Feed nicht erreichbar" : guest ? GUEST_FEED_REASON : "Spiel nicht im Live-Feed gefunden";
        await postUnchecked(env, item, reason);
      }
      continue;
    }
    done.add(item.id);
    const res = confirmLive(item, match);
    res.postOdds = oddsSnapshot(match);
    res.signalOdds = item.signalOdds || null;
    if (res.ok) {
      const label = `🔥 High Confidence (${Math.round(item.proba * 100)}% → live ${Math.round(res.score.proba * 100)}%)`;
      // Expected hit rate: the lower of the live model and the goal-score band.
      const expected = Math.min(res.score.proba, res.goal.wr || res.score.proba);
      const mq = minQuote(expected);
      const units = res.goal.points >= 1 ? UNITS_STRONG : UNITS_NORMAL;
      const post = await postPremium(env, buildPremiumMessage(item.text, label) + "\n" + confirmationBlock(res) + "\n\n" +
          stakeAdvice(item.parsed.targetLine, mq, units, res.postOdds));
      await trackSignal(env, {
        ...post,
        tier: "premium", home: item.parsed.homeTeam, away: item.parsed.awayTeam, matchId: match.id || null,
        line: item.parsed.targetLine, minute: res.live.minute, minQuote: mq, units, odds: res.postOdds,
      });
      await logPremiumForward(env, item.parsed, res.score, "premium:fwd", {
        signalOdds: item.signalOdds || null,
        postOdds: res.postOdds,
        goalPoints: res.goal ? res.goal.points : null,
        marketProba: res.market != null ? res.market : null,
      });
      await logConfirmation(env, item, res, "premium:ok");
    } else {
      await logConfirmation(env, item, res, "premium:rej");
    }
  }

  if (done.size) {
    // Re-read so a card queued by the webhook while we were working isn't lost.
    const latest = await readPending(env);
    const left = latest.filter((p) => !done.has(p.id));
    if (left.length) {
      await env.ACCESS_KV.put(PENDING_KEY, JSON.stringify(left), { expirationTtl: 24 * 60 * 60 });
    } else {
      await env.ACCESS_KV.delete(PENDING_KEY);
    }
  }
}

// Minimum decimal quote at which a bet with hit rate `wr` breaks even,
// rounded up to two decimals so the advice is never on the losing side.
function minQuote(wr) {
  return wr ? Math.ceil((1 / wr) * 100) / 100 : null;
}

function fmtQuote(q) {
  return q.toFixed(2).replace(".", ",");
}

// "Nur setzen ab …" line plus a warning when the logged live quote for the
// target line is already below it.
function stakeAdvice(line, mq, units, odds) {
  const unitsText = String(units).replace(".", ",");
  const out = [`💶 Nur setzen ab Quote ${fmtQuote(mq)} (Over ${line}) · Einsatz: ${unitsText} ${units === 1 ? "Einheit" : "Einheiten"}`];
  if (odds && odds.line === line && odds.over < mq) {
    out.push(`⏳ Aktuelle Quote ${fmtQuote(odds.over)} liegt darunter: nur setzen, wenn sie noch steigt.`);
  }
  return out.join("\n");
}

async function readTracked(env) {
  const raw = await env.ACCESS_KV.get(TRACK_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch (e) {
    return [];
  }
}

// Remember a posted signal so the cron can settle it from the live feed.
async function trackSignal(env, entry) {
  const open = await readTracked(env);
  // Second line of defence against double posts: one open tip per match, line and tier.
  const same = (t) => t.tier === entry.tier && t.line === entry.line &&
    normTeam(t.home) === normTeam(entry.home) && normTeam(t.away) === normTeam(entry.away);
  if (open.some(same)) return;
  open.push({ id: randomToken().slice(0, 12), postedAt: Date.now(), ...entry });
  await env.ACCESS_KV.put(TRACK_KEY, JSON.stringify(open), { expirationTtl: 2 * 24 * 60 * 60 });
}

function findTrackedMatch(feed, t) {
  return (t.matchId && feed.find((m) => m.id === t.matchId)) || findMatch(feed, t.home, t.away);
}

async function settleTracked(env, feed) {
  const open = await readTracked(env);
  if (!open.length || !Array.isArray(feed)) return;
  const now = Date.now();
  let changed = false;
  const keep = [];
  const settled = new Set(); // duplicates of a tip settled in this run are dropped silently
  for (const t of open) {
    const k = tipKey(t.tier, t.home, t.away, t.line);
    if (settled.has(k)) {
      changed = true;
      continue;
    }
    const m = findTrackedMatch(feed, t);
    let result = null;
    if (m) {
      const goals = (num(m.hg) || 0) + (num(m.ag) || 0);
      const minute = num(m.minute);
      if (goals > t.line) {
        result = t.under ? "lost" : "won";
        t.resultMinute = minute;
      } else {
        if (minute != null && minute >= TRACK_LOST_AFTER_MIN && !t.late) {
          t.late = true;
          changed = true;
        }
        if (t.missingSince) {
          delete t.missingSince;
          changed = true;
        }
      }
    } else if (t.late) {
      if (!t.missingSince) {
        t.missingSince = now;
        changed = true;
      } else if (now - t.missingSince >= TRACK_MISSING_GRACE_MS) {
        result = t.under ? "won" : "lost";
      }
    } else if (now - t.postedAt >= TRACK_GIVE_UP_MS) {
      result = "void";
    }
    if (result) {
      settled.add(k);
      changed = true;
      await saveResult(env, t, result);
      try {
        await markPremiumPost(env, t, result);
      } catch (e) {}
      try {
        await maybePostFree(env, t, result);
      } catch (e) {}
    } else {
      keep.push(t);
    }
  }
  if (!changed) return; // most minutes: no KV write at all
  const latest = await readTracked(env);
  const keepIds = new Set(keep.map((t) => t.id));
  const openIds = new Set(open.map((t) => t.id));
  // Keep entries still open here, plus any tracked by the webhook meanwhile.
  const merged = keep.concat(latest.filter((t) => !openIds.has(t.id) && !keepIds.has(t.id)));
  if (merged.length) await env.ACCESS_KV.put(TRACK_KEY, JSON.stringify(merged), { expirationTtl: 2 * 24 * 60 * 60 });
  else await env.ACCESS_KV.delete(TRACK_KEY);
}

// Posts a tip to the premium channel and returns what is needed to mark it
// later: the message id and the exact text (editMessageText needs the whole text).
async function postPremium(env, text) {
  const sent = await sendTelegramMessage(env, env.PREMIUM_CHANNEL_ID, text);
  return sent && sent.message_id ? { msgId: sent.message_id, msgText: text } : {};
}

// When a tip is decided, put the result on top of its premium post, wins and
// losses alike, so nobody has to mark them by hand.
function resultBanner(t, result) {
  const at = t.resultMinute != null ? ` in Minute ${t.resultMinute}'` : "";
  if (t.under) return result === "won" ? "✅ WIN – höchstens noch 1 Tor" : `❌ LOST – 2. Tor${at}`;
  return result === "won" ? `✅ WIN – Tor${at}` : "❌ LOST – kein weiteres Tor";
}

async function markPremiumPost(env, t, result) {
  if (!t.msgId || !t.msgText || (result !== "won" && result !== "lost")) return;
  const text = `${resultBanner(t, result)}\n\n${t.msgText}`.slice(0, 4096);
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: env.PREMIUM_CHANNEL_ID, message_id: t.msgId, text }),
  }).catch(() => null);
}

async function saveResult(env, t, result) {
  const now = new Date();
  // Profit in units only where the logged quote is for the signal's own line.
  const quoteSide = t.under ? "under" : "over";
  const priced = t.odds && t.odds.line === t.line && t.odds[quoteSide] ? t.odds[quoteSide] : null;
  const betPlaced = priced != null && priced >= t.minQuote;
  let profit = null;
  if (betPlaced && result !== "void") profit = result === "won" ? t.units * (priced - 1) : -t.units;
  const record = {
    tier: t.tier, home: t.home, away: t.away, line: t.line, minute: t.minute,
    postedAt: new Date(t.postedAt).toISOString(), settledAt: now.toISOString(),
    result, resultMinute: t.resultMinute != null ? t.resultMinute : null,
    units: t.units, minQuote: t.minQuote, quote: priced, betPlaced,
    profit: profit != null ? Math.round(profit * 100) / 100 : null,
  };
  // The record is also stored as key metadata, so listing results (public
  // results page, reports) needs one KV list call per 1000 tips, not one get each.
  await env.ACCESS_KV.put(`result:${now.getTime()}:${t.id}`, JSON.stringify(record), {
    expirationTtl: 365 * 24 * 60 * 60,
    metadata: resultMeta(record),
  });
}

// KV metadata is limited to 1024 bytes; team names are cut to stay well below.
function resultMeta(record) {
  return { ...record, home: String(record.home || "").slice(0, 40), away: String(record.away || "").slice(0, 40) };
}

async function listResults(env, sinceMs) {
  const rows = [];
  let backfillLeft = 100; // metadata backfill writes per call, keeps KV ops bounded
  let cursor;
  do {
    const list = await env.ACCESS_KV.list({ prefix: "result:", cursor });
    for (const key of list.keys) {
      const ts = Number(key.name.split(":")[1]);
      if (sinceMs && ts < sinceMs) continue;
      if (key.metadata && key.metadata.result) {
        rows.push(key.metadata);
        continue;
      }
      // Older results were saved without metadata: read them and add it once.
      const raw = await env.ACCESS_KV.get(key.name);
      if (raw) {
        try {
          const record = JSON.parse(raw);
          rows.push(record);
          if (backfillLeft-- > 0 && key.expiration) {
            await env.ACCESS_KV.put(key.name, raw, { expiration: key.expiration, metadata: resultMeta(record) });
          }
        } catch (e) {}
      }
    }
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);
  rows.sort((a, b) => b.settledAt.localeCompare(a.settledAt));
  // The same posted tip settled twice (overlapping runs before 14.10.) keeps only its first result.
  const seen = new Set();
  const unique = [];
  for (const r of rows.slice().reverse()) {
    const k = [r.tier, normTeam(r.home), normTeam(r.away), r.line, String(r.postedAt).slice(0, 10)].join("|");
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(r);
  }
  return unique.reverse();
}

// --- Fill "unclear" (void) results from an InPlayFlux CSV export ---
// With the guest feed (~15 matches) many tips are never seen at the end and
// settle as "void" after 4 h. The export knows the outcome of every card, so
// the owner uploads it in the admin panel and void results get the real one.

function parseCsv(text) {
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1);
}

// One entry per decided card: time (naive, as written in the export), teams,
// target line, result. Raw exports (date split into two columns, one hour
// early) and normalized ones both work: matching allows a few hours of offset.
function exportCards(text) {
  const rows = parseCsv(text.replace(/^﻿/, ""));
  if (rows.length < 2) return [];
  const head = rows[0].map((h) => h.trim());
  const col = (re) => head.findIndex((h) => re.test(h));
  const ix = {
    match: col(/^Maç/), score: col(/^Skor/), target: col(/^Hedef/),
    result: col(/^Sonuç \(Result\)/), resultMin: col(/^Sonuç Dk/),
  };
  if (Object.values(ix).some((v) => v < 0)) return [];
  const clean = (v) => String(v || "").replace(/[="]/g, "").trim();
  const cards = [];
  for (let r of rows.slice(1)) {
    if (r.length === head.length + 1) r = [r[0] + "," + r[1]].concat(r.slice(2));
    if (r.length !== head.length) continue;
    const d = clean(r[0]);
    let m = d.match(/^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d)/);
    let t = m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5]) : null;
    if (!m && (m = d.match(/^(\d\d)\/(\d\d)\/(\d{4}),? (\d\d):(\d\d)/))) t = Date.UTC(+m[3], m[2] - 1, +m[1], +m[4], +m[5]);
    const teams = clean(r[ix.match]).split(/\s+vs\.?\s+/i);
    const res = r[ix.result];
    const won = /won/i.test(res) ? true : /lost/i.test(res) ? false : null;
    if (t == null || teams.length !== 2 || won == null) continue;
    const target = clean(r[ix.target]);
    if (/\b(HT|IY|İY|1st half)\b/i.test(target)) continue;
    let line = null;
    const o = target.match(/Over\s*(\d+(?:\.5)?)/i);
    if (o) line = Number(o[1]);
    else if (/goal/i.test(target)) {
      const s = clean(r[ix.score]).match(/(\d+)\s*-\s*(\d+)/);
      if (s) line = Number(s[1]) + Number(s[2]) + 0.5;
    }
    if (line == null) continue;
    cards.push({ t, home: normTeam(teams[0]), away: normTeam(teams[1]), line, won, minute: num(clean(r[ix.resultMin])) });
  }
  return cards;
}

const FILL_WINDOW_MS = 6 * 60 * 60 * 1000; // card time vs posting time (time zone + export shift)

// Outcome of a void tip from the export cards of the same match, or null.
function outcomeFromCards(rec, cards) {
  const posted = Date.parse(rec.postedAt);
  const same = cards.filter((c) => c.home === normTeam(rec.home) && c.away === normTeam(rec.away) &&
    Math.abs(c.t - posted) <= FILL_WINDOW_MS);
  const pick = (list) => {
    if (!list.length || list.some((c) => c.won !== list[0].won)) return null; // none or contradicting
    const mins = list.map((c) => c.minute).filter((x) => x != null);
    return { won: list[0].won, minute: mins.length ? Math.min(...mins) : null };
  };
  if (rec.tier !== "under") {
    const o = pick(same.filter((c) => c.line === rec.line));
    return o && { result: o.won ? "won" : "lost", resultMinute: o.won ? o.minute : null };
  }
  // Under 3.5 (from an O2.5 card at 2 goals): lost only if 4+ goals.
  const o35 = pick(same.filter((c) => c.line === 3.5));
  if (o35) return { result: o35.won ? "lost" : "won", resultMinute: o35.won ? o35.minute : null };
  const o25 = pick(same.filter((c) => c.line === 2.5));
  if (o25 && !o25.won) return { result: "won", resultMinute: null };
  return null; // 3rd goal fell, 4th unknown
}

async function fillUnclear(env, text, apply) {
  const cards = exportCards(text);
  if (!cards.length) return { error: "Keine Karten in der Datei gefunden (InPlayFlux-CSV-Export?)." };
  const voids = [];
  let cursor;
  do {
    const list = await env.ACCESS_KV.list({ prefix: "result:", cursor });
    for (const key of list.keys) if (key.metadata && key.metadata.result === "void") voids.push(key);
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);
  const filled = [];
  let missing = 0;
  for (const key of voids) {
    const o = outcomeFromCards(key.metadata, cards);
    if (!o) { missing++; continue; }
    filled.push({ home: key.metadata.home, away: key.metadata.away, tier: key.metadata.tier, line: key.metadata.line, ...o });
    if (!apply) continue;
    const raw = await env.ACCESS_KV.get(key.name);
    if (!raw) continue;
    const rec = { ...JSON.parse(raw), ...o, filledFrom: "csv" };
    if (rec.betPlaced) rec.profit = Math.round((o.result === "won" ? rec.units * (rec.quote - 1) : -rec.units) * 100) / 100;
    await env.ACCESS_KV.put(key.name, JSON.stringify(rec), {
      ...(key.expiration ? { expiration: key.expiration } : {}),
      metadata: resultMeta(rec),
    });
  }
  return { cards: cards.length, voids: voids.length, filled, missing, applied: !!apply };
}

function summarize(rows) {
  const decided = rows.filter((r) => r.result === "won" || r.result === "lost");
  const tally = (list) => ({ n: list.length, won: list.filter((r) => r.result === "won").length });
  const priced = decided.filter((r) => r.profit != null);
  return {
    all: tally(decided),
    premium: tally(decided.filter((r) => r.tier === "premium")),
    risk: tally(decided.filter((r) => r.tier === "risk")),
    half: tally(decided.filter((r) => r.tier === "half")),
    under: tally(decided.filter((r) => r.tier === "under")),
    o15: tally(decided.filter((r) => r.tier === "o15")),
    priced: priced.length,
    profit: Math.round(priced.reduce((a, r) => a + r.profit, 0) * 100) / 100,
    staked: priced.reduce((a, r) => a + r.units, 0),
  };
}

function pctText(t) {
  return t.n ? `${t.won}/${t.n} = ${(Math.round((t.won / t.n) * 1000) / 10).toString().replace(".", ",")} %` : "–";
}

// Profit/return is only shown from this many priced tips on. Tips count as
// priced only when the feed's live quote was for the tip's own line, which
// is rare (the market's main line is usually higher than the target line).
const MIN_PRICED_FOR_PROFIT = 20;

function weeklyReportText(sum, fromDate, toDate) {
  const d = (x) => x.toISOString().slice(8, 10) + "." + x.toISOString().slice(5, 7) + ".";
  const lines = [
    `📊 Wochenbilanz Premium (${d(fromDate)}–${d(toDate)})`,
    "",
    // Tiers without decided tips that week (e.g. the switched-off Risiko) are left out.
    ...[
      ["🔥 High Confidence", sum.premium], ["🟠 Half-Risiko", sum.half], ["⚠️ Risiko (seit 13.10. abgeschaltet)", sum.risk],
      ["🛡️ Under 3.5 (seit 21.10. pausiert)", sum.under], ["🧪 Over 1.5 Test (seit 21.10.)", sum.o15],
    ].filter(([, t]) => t && t.n).map(([label, t]) => `${label}: ${pctText(t)}`),
    `Gesamt: ${pctText(sum.all)}`,
  ];
  // The profit line needs enough priced tips to mean anything; a handful
  // (often only Risiko tips at 0.5 units) gives figures like -100 %.
  if (sum.priced >= MIN_PRICED_FOR_PROFIT) {
    const sign = sum.profit >= 0 ? "+" : "";
    const roi = sum.staked ? Math.round((sum.profit / sum.staked) * 1000) / 10 : 0;
    lines.push("", `💶 Mit Quote ab Mindestquote gesetzt (${sum.priced} ${sum.priced === 1 ? "Tipp" : "Tipps"}): ${sign}${String(sum.profit).replace(".", ",")} Einheiten (Rendite ${sign}${String(roi).replace(".", ",")} %)`);
  }
  lines.push("", "Automatisch ausgewertet aus dem Live-Spielstand. Keine Gewinngarantie, 18+.");
  return lines.join("\n");
}

async function sendWeeklyReport(env) {
  const to = new Date();
  const from = new Date(to.getTime() - 7 * DAY_MS);
  const sum = summarize(await listResults(env, from.getTime()));
  if (!sum.all.n) return;
  const text = weeklyReportText(sum, from, to);
  await sendTelegramMessage(env, env.PREMIUM_CHANNEL_ID, text + `\n📋 Alle Ergebnisse: ${RESULTS_PAGE_URL}`);
  await sendTelegramMessage(env, freeChannel(env), text + "\n\n" + freeCta(env));
}

// ---------------------------------------------------------------------
// Free showcase channel (public, @MoneyBagAnalyst by default): the weekly
// report plus the first FREE_PER_DAY premium tips of each day that have
// finished - won or lost, whichever settles first, never picked by result -
// posted only after the match is decided, so the premium channel keeps its
// value. Override with FREE_CHANNEL_ID / FREE_CTA_URL in Cloudflare.
const FREE_PER_DAY = 3;
const FREE_TIER_LABEL = { premium: "🔥 High Confidence", half: "🟠 Half-Risiko", risk: "⚠️ Risiko", under: "🛡️ Mit Vorsicht", o15: "🧪 Over 1.5 Test" };

function freeChannel(env) {
  return env.FREE_CHANNEL_ID || "@MoneyBagAnalyst";
}

function freeCta(env) {
  const url = env.FREE_CTA_URL || "https://moneybag-signals.com";
  return `💎 Alle Signale live – vor dem Tor – im Premium-Kanal: ${url}\n📋 Alle Ergebnisse (nichts gelöscht): ${RESULTS_PAGE_URL}\n18+ · Keine Gewinngarantie · Hilfe: check-dein-spiel.de`;
}

function freeSignalText(t, result, env, when = "von heute") {
  const tip = t.under ? `Under ${t.line}` : `Over ${t.line}`;
  const outcome = t.under
    ? (result === "won" ? "✅ Treffer – höchstens noch 1 Tor" : `❌ verloren – 2. Tor${t.resultMinute != null ? ` in Minute ${t.resultMinute}` : ""}`)
    : (result === "won" ? `✅ Treffer – Tor${t.resultMinute != null ? ` in Minute ${t.resultMinute}` : ""}` : "❌ verloren – kein weiteres Tor");
  return [
    `📢 Gratis-Einblick: Signal ${when} (Spiel bereits entschieden)`,
    "",
    `${FREE_TIER_LABEL[t.tier] || "🔥 Premium"} · ${tip}`,
    `⚽ ${t.home || "?"} – ${t.away || "?"}`,
    `⏱ Signal in Minute ${t.minute != null ? t.minute : "?"}'`,
    `Ergebnis: ${outcome}`,
    "",
    freeCta(env),
  ].join("\n");
}

async function maybePostFree(env, t, result) {
  if (result !== "won" && result !== "lost") return;
  const key = `free:count:${new Date().toISOString().slice(0, 10)}`;
  const count = Number(await env.ACCESS_KV.get(key)) || 0;
  if (count >= FREE_PER_DAY) return;
  // Never show the same tip twice in the free channel (17.10.: one tip posted three times).
  const sentKey = `free:sent:${tipKey(t.tier, t.home, t.away, t.line)}`;
  if (await env.ACCESS_KV.get(sentKey)) return;
  const sent = await sendTelegramMessage(env, freeChannel(env), freeSignalText(t, result, env));
  if (sent) await env.ACCESS_KV.put(sentKey, "1", { expirationTtl: 2 * DAY_MS / 1000 });
  if (sent) await env.ACCESS_KV.put(key, String(count + 1), { expirationTtl: 2 * DAY_MS / 1000 });
}

// ---------------------------------------------------------------------
// Public results page /ergebnisse: every settled premium tip, newest first,
// straight from result:* (nothing hidden or picked). Only decided matches
// appear, so it never gives away a live signal. Cached at the edge for
// RESULTS_CACHE_S so page views cost no KV reads.
const RESULTS_PAGE_URL = "https://moneybag-signals.com/ergebnisse";
const RESULTS_CACHE_S = 300;
const RESULTS_PAGE_ROWS = 150;
const RESULT_TIERS = [
  ["premium", "🔥 High Confidence"], ["half", "🟠 Half-Risiko"], ["risk", "⚠️ Risiko (seit 13.10. abgeschaltet)"], ["under", "🛡️ Under 3.5 (seit 21.10. pausiert)"],
  ["o15", "🧪 Over 1.5 Test (seit 21.10.)"],
];

function htmlEsc(v) {
  return String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function berlin(iso, opts) {
  return new Date(iso).toLocaleString("de-DE", { timeZone: "Europe/Berlin", ...opts });
}

function rateCell(t) {
  if (!t.n) return "–";
  return `<b>${(Math.round((t.won / t.n) * 1000) / 10).toString().replace(".", ",")} %</b><small>${t.won} von ${t.n}</small>`;
}

function resultsPageHtml(rows, env, nowMs) {
  const since = (days) => rows.filter((r) => Date.parse(r.settledAt) >= nowMs - days * DAY_MS);
  const periods = [["7 Tage", summarize(since(7))], ["30 Tage", summarize(since(30))], ["Gesamt", summarize(rows)]];
  const tiers = RESULT_TIERS.filter(([key]) => periods[2][1][key].n);
  const head = `<tr><th></th>${periods.map(([l]) => `<th>${l}</th>`).join("")}</tr>`;
  const body = tiers.map(([key, label]) => `<tr><td>${label}</td>${periods.map(([, s]) => `<td>${rateCell(s[key])}</td>`).join("")}</tr>`).join("")
    + `<tr class="total"><td>Alle Stufen</td>${periods.map(([, s]) => `<td>${rateCell(s.all)}</td>`).join("")}</tr>`;
  const all = periods[2][1];
  let profit = "";
  if (all.priced >= MIN_PRICED_FOR_PROFIT) {
    const sign = all.profit >= 0 ? "+" : "";
    const roi = all.staked ? Math.round((all.profit / all.staked) * 1000) / 10 : 0;
    profit = `<p class="note">Tipps mit erfasster Live-Quote ab Mindestquote (${all.priced}): <b>${sign}${String(all.profit).replace(".", ",")} Einheiten</b> (Rendite ${sign}${String(roi).replace(".", ",")} %).</p>`;
  }
  // Last 14 days as small won/lost bars.
  const dayKey = (iso) => berlin(iso, { year: "numeric", month: "2-digit", day: "2-digit" });
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const iso = new Date(nowMs - i * DAY_MS).toISOString();
    const list = rows.filter((r) => dayKey(r.settledAt) === dayKey(iso));
    days.push({ label: berlin(iso, { day: "2-digit", month: "2-digit" }), won: list.filter((r) => r.result === "won").length, lost: list.filter((r) => r.result === "lost").length });
  }
  const maxDay = Math.max(1, ...days.map((d) => d.won + d.lost));
  const bars = days.map((d) => `<div class="day"><div class="stack"><span class="l" style="height:${(d.lost / maxDay) * 100}%"></span><span class="w" style="height:${(d.won / maxDay) * 100}%"></span></div><small>${d.won}/${d.won + d.lost}</small><small>${d.label}</small></div>`).join("");
  const label = Object.fromEntries(RESULT_TIERS);
  const list = rows.slice(0, RESULTS_PAGE_ROWS).map((r) => {
    const tip = `${r.tier === "under" ? "Under" : "Over"} ${String(r.line).replace(".", ",")}`;
    const res = r.result === "won" ? '<span class="ok">✅ Treffer</span>' : r.result === "lost" ? '<span class="no">❌ verloren</span>' : '<span class="void">– ungewertet</span>';
    const goal = r.resultMinute != null && r.tier !== "under" && r.result === "won" ? ` <small>Tor ${r.resultMinute}'</small>` : "";
    return `<tr><td>${berlin(r.postedAt, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</td><td>${htmlEsc(r.home)} – ${htmlEsc(r.away)}<small>${label[r.tier] || r.tier} · ${tip} · Signal ${r.minute != null ? r.minute + "'" : "?"}</small></td><td>${res}${goal}</td></tr>`;
  }).join("");
  const free = String(freeChannel(env)).replace(/^@/, "");
  const freeLink = /^-?\d+$/.test(free) ? "https://t.me/MoneyBagAnalyst" : `https://t.me/${htmlEsc(free)}`;
  const updated = berlin(new Date(nowMs).toISOString(), { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MoneyBag – Alle Ergebnisse</title><meta name="description" content="Alle abgeschlossenen MoneyBag-Signale mit Ergebnis – automatisch erfasst, nichts gelöscht.">
<style>
:root{--bg:#0b1630;--card:#13234a;--line:#24396b;--text:#eef2fb;--muted:#a9b6d3;--gold:#f5c542;--ok:#2ecc71;--no:#ff6b5b}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px 48px}h1{font-size:28px;margin:0 0 4px}h1 span{color:var(--gold)}h2{font-size:19px;margin:32px 0 10px}
.sub{color:var(--muted);margin:0 0 20px}.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:4px 0;overflow-x:auto}
table{width:100%;border-collapse:collapse}th,td{padding:10px 12px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}tr:last-child td{border-bottom:0}
th{color:var(--muted);font-weight:600;font-size:14px}td small{display:block;color:var(--muted);font-size:13px}td b{font-size:17px}
.rates td:not(:first-child),.rates th:not(:first-child){text-align:right}.total td{background:rgba(245,197,66,.08)}
.ok{color:var(--ok);font-weight:600}.no{color:var(--no);font-weight:600}.void{color:var(--muted)}
.days{display:flex;gap:6px;align-items:flex-end;padding:14px 12px}.day{flex:1;text-align:center;min-width:0}.day small{display:block;color:var(--muted);font-size:11px;white-space:nowrap}
.stack{height:90px;display:flex;flex-direction:column-reverse;border-radius:6px;overflow:hidden;background:rgba(255,255,255,.04)}.stack .w{background:var(--ok)}.stack .l{background:var(--no)}
.note{color:var(--muted);font-size:14px}.cta{display:inline-block;margin-top:8px;background:var(--gold);color:#1a1300;font-weight:700;padding:12px 18px;border-radius:12px;text-decoration:none}
footer{margin-top:36px;color:var(--muted);font-size:13px;border-top:1px solid var(--line);padding-top:16px}footer a{color:var(--muted)}
@media(max-width:520px){h1{font-size:23px}th,td{padding:9px 6px;font-size:14px}td b{font-size:15px}.rates b,.rates small{white-space:nowrap}.day small:first-of-type{display:none}}
</style></head><body><main>
<h1>💰 MoneyBag <span>Ergebnisse</span></h1>
<p class="sub">Jedes Premium-Signal mit Ergebnis – automatisch aus dem Live-Spielstand erfasst. Nichts gelöscht, nichts ausgewählt. Stand: ${updated}</p>
<h2>Trefferquote</h2><div class="card"><table class="rates">${head}${body}</table></div>
${profit}
<p class="note">Treffer = das gesuchte Tor fiel (bei „Under 3.5“: kein weiteres Tor). Ungewertete Spiele (Abbruch, Daten fehlen) zählen nicht mit.</p>
<h2>Letzte 14 Tage</h2><div class="card"><div class="days">${bars}</div></div>
<p class="note">Grün = Treffer, Rot = verloren. Zahl = Treffer/Signale.</p>
<h2>Alle Signale${rows.length > RESULTS_PAGE_ROWS ? ` (neueste ${RESULTS_PAGE_ROWS} von ${rows.length})` : ""}</h2>
<div class="card"><table><tr><th>Zeit</th><th>Spiel</th><th>Ergebnis</th></tr>${list || '<tr><td colspan="3">Noch keine abgeschlossenen Signale.</td></tr>'}</table></div>
<h2>Selbst verfolgen</h2>
<p>3 Signale pro Tag gratis (mit Ergebnis) und die Wochenbilanz im Telegram-Kanal:</p>
<a class="cta" href="${freeLink}">📢 Gratis-Kanal öffnen</a>
<footer>18+ · Sportwetten bergen Verlustrisiken · Keine Gewinngarantie · Vergangene Ergebnisse sagen nichts über künftige aus.<br>Hilfe bei Glücksspielproblemen: <a href="https://www.check-dein-spiel.de">check-dein-spiel.de</a> · BZgA-Hotline 0800 1 37 27 00</footer>
</main></body></html>`;
}

async function resultsPage(request, env, ctx) {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = new Request(new URL("/ergebnisse", request.url).toString());
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }
  const rows = await listResults(env);
  const res = new Response(resultsPageHtml(rows, env, Date.now()), {
    headers: { "content-type": "text/html; charset=utf-8", "Cache-Control": `public, max-age=${RESULTS_CACHE_S}`, ...SECURITY_HEADERS },
  });
  if (cache) {
    const put = cache.put(cacheKey, res.clone());
    if (ctx && ctx.waitUntil) ctx.waitUntil(put);
    else await put;
  }
  return res;
}

async function listLog(env, prefix) {
  const rows = [];
  let cursor;
  do {
    const list = await env.ACCESS_KV.list({ prefix, cursor });
    for (const key of list.keys) {
      const raw = await env.ACCESS_KV.get(key.name);
      if (raw) {
        try {
          const record = JSON.parse(raw);
          rows.push(record);
          if (backfillLeft-- > 0 && key.expiration) {
            await env.ACCESS_KV.put(key.name, raw, { expiration: key.expiration, metadata: resultMeta(record) });
          }
        } catch (e) {}
      }
    }
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);
  rows.sort((a, b) => b.decidedAt.localeCompare(a.decidedAt));
  return rows;
}

// One CSV row per logged decision, for scripts/premium_report.py:
//   forwarded / risk / half -> posted to the premium channel (premium:fwd / risk:fwd / half:fwd)
//   confirmed / rejected -> outcome of the 2-minute live check (premium:ok / premium:rej)
async function premiumExportCsv(env) {
  const kinds = [
    ["premium:fwd:", "forwarded"],
    ["risk:fwd:", "risk"],
    ["half:fwd:", "half"],
    ["o15:fwd:", "o15_test"],
    ["under:fwd:", "under35"],
    ["premium:ok:", "confirmed"],
    ["premium:rej:", "rejected"],
    ["half:rej:", "half_rejected"],
  ];
  const cols = [
    "kind", "time", "date", "home", "away", "target_line", "signal_minute", "signal_proba",
    "live_minute", "live_score", "live_proba", "goal_points", "market_proba",
    "signal_over", "signal_under", "signal_line", "post_over", "post_under", "post_line", "reason",
  ];
  const cell = (v) => {
    const t = v == null ? "" : String(v);
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const lines = [cols.join(",")];
  for (const [prefix, kind] of kinds) {
    let cursor;
    do {
      const list = await env.ACCESS_KV.list({ prefix, cursor });
      for (const key of list.keys) {
        const raw = await env.ACCESS_KV.get(key.name);
        if (!raw) continue;
        let r;
        try {
          r = JSON.parse(raw);
        } catch (e) {
          continue;
        }
        const live = r.live || {};
        const so = r.signalOdds || {};
        const po = r.postOdds || {};
        lines.push([
          kind, r.forwardedAt || r.decidedAt, r.date, r.homeTeam, r.awayTeam, r.targetLine,
          r.signalMinute != null ? r.signalMinute : r.minute,
          r.signalProba != null ? r.signalProba : r.modelProba,
          live.minute, live.score, r.liveProba, r.goalPoints, r.marketProba,
          so.over, so.under, so.line, po.over, po.under, po.line, r.reason,
        ].map(cell).join(","));
      }
      cursor = list.list_complete ? undefined : list.cursor;
    } while (cursor);
  }
  return lines.join("\n") + "\n";
}

async function resolveAccess(request, env) {
  const cookies = parseCookies(request);
  const url = new URL(request.url);
  const queryToken = url.searchParams.get("t");
  const token = queryToken || cookies[COOKIE_NAME];
  if (!token) return { ok: false, reason: "missing" };
  const access = await getAccess(env, token);
  if (!access) return { ok: false, reason: "invalid" };
  if (access.expiresAt < Date.now()) return { ok: false, reason: "expired" };
  return { ok: true, token, queryToken, access };
}

function deniedPage({ reason }) {
  const messages = {
    missing: "Kein Zugangslink erkannt. Bitte nutze den Link, den du erhalten hast.",
    invalid: "Dieser Zugangslink ist ungültig.",
    expired: "Dein 24-Stunden-Testzugang ist abgelaufen.",
  };
  const message = messages[reason] || messages.invalid;
  return htmlResponse(`<!DOCTYPE html>
<html lang="de"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Zugang</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background:#12151c; color:#e6e9f0; max-width:480px; margin:0 auto; padding:40px 20px; line-height:1.5; }
  h1 { font-size:1.2rem; }
  .box { background:#1a1f2b; border:1px solid #2c3444; border-radius:6px; padding:18px; margin-top:16px; }
  a { color:#c9a227; }
  input, textarea { width:100%; box-sizing:border-box; background:#202634; color:#e6e9f0; border:1px solid #2c3444; border-radius:4px; padding:9px; margin-bottom:10px; font-family:inherit; font-size:0.95rem; }
  textarea { resize:vertical; min-height:70px; }
  button { background:#c9a227; color:#1a1200; border:none; border-radius:4px; padding:10px 16px; font-weight:600; cursor:pointer; font-size:0.95rem; }
  button:disabled { opacity:0.6; cursor:default; }
  .status { margin-top:10px; font-size:0.85rem; }
  .status.ok { color:#4caf7a; }
  .status.err { color:#d9614f; }
  label { display:block; font-size:0.8rem; color:#8891a3; margin-bottom:4px; }
</style></head>
<body>
  <h1>Zugang erforderlich</h1>
  <p>${message}</p>
  <div class="box">
    <p><strong>Weiter nutzen?</strong><br>
    Am schnellsten geht's direkt über Telegram — oder per Formular, wenn du kein Telegram nutzt.</p>
    <a href="https://t.me/harzpassage_bot" target="_blank" rel="noopener" style="display:block; text-align:center; background:#4caf7a; color:#0d1310; text-decoration:none; font-weight:700; padding:12px 16px; border-radius:6px; margin-bottom:16px;">💬 Direkt über Telegram schreiben</a>
    <p style="text-align:center; color:#8891a3; font-size:0.85rem; margin:-8px 0 16px;">— oder —</p>
    <form id="contact-form">
      <label>Name</label>
      <input type="text" id="c-name" required maxlength="100">
      <label>E-Mail-Adresse</label>
      <input type="email" id="c-email" required maxlength="150">
      <label>Nachricht (optional)</label>
      <textarea id="c-message" maxlength="500"></textarea>
      <button type="submit" id="c-submit">Anfrage senden</button>
      <div class="status" id="c-status"></div>
    </form>
  </div>
  <script>
    document.getElementById('contact-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('c-submit');
      const out = document.getElementById('c-status');
      const name = document.getElementById('c-name').value.trim();
      const email = document.getElementById('c-email').value.trim();
      const message = document.getElementById('c-message').value.trim();
      btn.disabled = true;
      out.className = 'status';
      out.textContent = 'Wird gesendet …';
      try {
        const r = await fetch('/api/contact', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, email, message }),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || ('Fehler ' + r.status));
        out.className = 'status ok';
        out.textContent = 'Danke! Wir melden uns zeitnah bei dir.';
        e.target.reset();
      } catch (err) {
        out.className = 'status err';
        out.textContent = 'Senden fehlgeschlagen: ' + err.message;
        btn.disabled = false;
      }
    });
  </script>
</body></html>`, 403);
}

async function handleAdminPage() {
  return htmlResponse(`<!DOCTYPE html>
<html lang="de"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Zugangsverwaltung</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background:#12151c; color:#e6e9f0; max-width:640px; margin:0 auto; padding:20px 14px 60px; }
  h1 { font-size:1.1rem; }
  section { background:#1a1f2b; border:1px solid #2c3444; border-radius:6px; padding:14px; margin-bottom:14px; }
  label { display:block; font-size:0.8rem; color:#8891a3; margin-bottom:4px; }
  input { width:100%; box-sizing:border-box; background:#202634; color:#e6e9f0; border:1px solid #2c3444; border-radius:4px; padding:8px; margin-bottom:10px; font-family:inherit; }
  button { background:#c9a227; color:#1a1200; border:none; border-radius:4px; padding:10px 14px; font-weight:600; cursor:pointer; }
  table { width:100%; border-collapse:collapse; font-size:0.8rem; }
  td, th { padding:6px; border-bottom:1px solid #2c3444; text-align:left; }
  .out { margin-top:10px; font-size:0.85rem; word-break:break-all; }
  .link { font-family:ui-monospace, monospace; background:#202634; padding:8px; border-radius:4px; display:block; margin-top:6px; }
</style></head>
<body>
<h1>Zugangsverwaltung — MoneyBag Analyst</h1>

<section>
  <label>Admin-Passwort</label>
  <input type="password" id="pw" placeholder="Passwort">
</section>

<section>
  <h3>Neuen Testzugang erstellen (Standard: 24h)</h3>
  <label>Stunden</label>
  <input type="number" id="hours" value="24">
  <button id="create-btn">Link erstellen</button>
  <div class="out" id="create-out"></div>
</section>

<section>
  <h3>Zugang nach Zahlung verlängern</h3>
  <label>Token</label>
  <input type="text" id="ext-token" placeholder="Token aus dem Link">
  <label>Tage</label>
  <input type="number" id="ext-days" value="30">
  <button id="ext-btn">Verlängern</button>
  <div class="out" id="ext-out"></div>
</section>

<section>
  <h3>Bilanz (automatisch ausgewertet)</h3>
  <p style="font-size:0.8rem;color:#8891a3;margin:0 0 10px;">Jedes gepostete Signal wird im Live-Spielstand verfolgt und als Treffer oder Fehlschlag gewertet. Die Wochenbilanz geht jeden Montag um 10 Uhr (MESZ) automatisch in den Premium-Kanal.</p>
  <button id="test-btn" style="background:#2c3444;color:#e6e9f0;margin-bottom:8px;">Test-Signal an Premium-Kanal senden</button>
  <div class="out" id="test-out" style="margin-bottom:10px;"></div>
  <button id="test-o05-btn" style="background:#2c3444;color:#e6e9f0;margin-bottom:8px;">Test Over 0.5 senden</button>
  <div class="out" id="test-o05-out" style="margin-bottom:10px;"></div>
  <button id="free-fill-btn" style="margin-bottom:8px;">3 letzte Ergebnisse in Gratis-Kanal posten</button>
  <div class="out" id="free-fill-out" style="margin-bottom:10px;"></div>
  <button id="test-free-btn" style="background:#2c3444;color:#e6e9f0;margin-bottom:8px;">Test Gratis-Kanal senden</button>
  <div class="out" id="test-free-out" style="margin-bottom:10px;"></div>
  <button id="test-under-btn" style="background:#2c3444;color:#e6e9f0;margin-bottom:8px;">Test Under 3.5 senden</button>
  <div class="out" id="test-under-out" style="margin-bottom:10px;"></div>
  <button id="test-half-btn" style="background:#2c3444;color:#e6e9f0;margin-bottom:8px;">Test Half-Risiko senden</button>
  <div class="out" id="test-half-out" style="margin-bottom:10px;"></div>
  <button id="img-btn" style="margin-bottom:8px;">Bilanz-Grafik erstellen (7 Tage)</button>
  <div class="out" id="img-out" style="margin-bottom:10px;"></div>
  <button id="res7-btn">Letzte 7 Tage</button>
  <button id="res30-btn" style="margin-left:6px;">Letzte 30 Tage</button>
  <div id="res-out" style="margin-top:10px;"></div>
  <h4 style="margin:16px 0 6px;">Unklare Ergebnisse nachtragen</h4>
  <p style="font-size:0.8rem;color:#8891a3;margin:0 0 8px;">InPlayFlux-CSV-Export auswählen (roh oder bearbeitet). Erst Vorschau, dann Übernehmen. Nur Tipps mit „unklar“ werden geändert.</p>
  <input type="file" id="fill-file" accept=".csv,text/csv">
  <div style="margin-top:8px;"><button id="fill-prev-btn">Vorschau</button><button id="fill-apply-btn" style="margin-left:6px;">Übernehmen</button></div>
  <div class="out" id="fill-out" style="margin-top:8px;"></div>
</section>

<section>
  <h3>Under 3.5 (still protokolliert)</h3>
  <p style="font-size:0.8rem;color:#8891a3;margin:0 0 10px;">Jede Over-2.5-Karte wird ohne Post mitgeschrieben: Live-Linie, Quoten, Markt-Wahrscheinlichkeit. Under 3.5 gewinnt, wenn höchstens noch ein Tor fällt. Gewinn nur dort gerechnet, wo die Live-Linie genau 3,5 war (dann ist die Under-Quote die echte Under-3.5-Quote).</p>
  <button id="u35-btn">Auswerten (14 Tage)</button>
  <button id="u35-csv-btn" style="margin-left:6px;">CSV</button>
  <div id="u35-out" style="margin-top:10px;"></div>
</section>

<section>
  <h3>Premium-Bestätigungen</h3>
  <p style="font-size:0.8rem;color:#8891a3;margin:0 0 10px;">High-Confidence-Signale werden 2 min nach der Karte live geprüft und nur dann gepostet, wenn sie noch passen. Half-Risiko-Karten (68–69') werden sofort geprüft und stehen ebenfalls hier, mit 🟠 markiert.</p>
  <button id="confirm-btn">Aktualisieren</button>
  <button id="export-btn" style="margin-left:6px;">Log als CSV exportieren</button>
  <div id="confirm-out" style="margin-top:10px;"></div>
</section>

<section>
  <h3>Backup</h3>
  <p style="font-size:0.8rem;color:#8891a3;margin:0 0 10px;">Sichert alle Zugänge, Premium-Logs und Warteschlangen. Datei z. B. in Dropbox oder iCloud ablegen. Einspielen überschreibt gleichnamige Einträge, löscht aber nichts.</p>
  <button id="backup-btn">Backup herunterladen</button>
  <label for="restore-file" style="margin-top:12px;">Backup einspielen (JSON-Datei)</label>
  <input type="file" id="restore-file" accept="application/json,.json">
  <button id="restore-btn">Einspielen</button>
  <div class="out" id="backup-out"></div>
</section>

<section>
  <h3>Alle Zugänge</h3>
  <button id="list-btn">Aktualisieren</button>
  <div id="list-out" style="margin-top:10px;"></div>
</section>

<script>
function pw() { return document.getElementById('pw').value; }
async function api(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + pw(), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!r.ok) throw new Error('Fehler ' + r.status + ' (falsches Passwort?)');
  return r.json();
}

document.getElementById('create-btn').addEventListener('click', async () => {
  const out = document.getElementById('create-out');
  try {
    const hours = parseFloat(document.getElementById('hours').value) || 24;
    const res = await api('/admin/api/create', { hours });
    out.innerHTML = 'Link erstellt: <span class="link">' + res.url + '</span>';
  } catch (e) { out.textContent = e.message; }
});

document.getElementById('ext-btn').addEventListener('click', async () => {
  const out = document.getElementById('ext-out');
  try {
    const token = document.getElementById('ext-token').value.trim();
    const days = parseFloat(document.getElementById('ext-days').value) || 30;
    const res = await api('/admin/api/extend', { token, days });
    out.textContent = 'Verlängert bis: ' + new Date(res.expiresAt).toLocaleString('de-DE');
  } catch (e) { out.textContent = e.message; }
});

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function pct(v) { return v == null ? '-' : Math.round(v * 100) + '%'; }
function hm(iso) { return iso ? new Date(iso).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-'; }

document.getElementById('confirm-btn').addEventListener('click', async () => {
  const out = document.getElementById('confirm-out');
  out.textContent = 'Lade …';
  try {
    const r = await fetch('/admin/api/confirm-log', { headers: { 'Authorization': 'Bearer ' + pw() } });
    if (!r.ok) throw new Error('Fehler ' + r.status + ' (falsches Passwort?)');
    const data = await r.json();
    const rows = data.confirmed.map(x => Object.assign({ ok: true }, x))
      .concat(data.rejected.map(x => Object.assign({ ok: false }, x)))
      .sort((a, b) => b.decidedAt.localeCompare(a.decidedAt));
    const total = rows.length;
    const okCount = data.confirmed.length;
    let html = '<div style="font-size:0.85rem;margin-bottom:8px;">Wartend: <b>' + data.pending.length + '</b> · Gepostet: <b>' + okCount + '</b> · Verworfen: <b>' + (total - okCount) + '</b></div>';
    if (data.pending.length) {
      html += '<div style="font-size:0.8rem;color:#8891a3;margin-bottom:8px;">Wartet: ' + data.pending.map(p => esc((p.parsed.homeTeam || '?') + ' – ' + (p.parsed.awayTeam || '?'))).join(', ') + '</div>';
    }
    if (!total) { out.innerHTML = html + 'Noch keine Entscheidungen.'; return; }
    html += '<table><tr><th>Zeit</th><th>Spiel</th><th>Ergebnis</th><th>Live</th></tr>';
    rows.slice(0, 100).forEach(x => {
      const q = o => o ? 'O' + esc(o.line) + ' @ ' + Number(o.over).toFixed(2) : '-';
      const live = (x.live && x.live.minute != null ? x.live.minute + "' " + esc(x.live.score) : '-') +
        '<br><small>Signal ' + q(x.signalOdds) + '<br>Post ' + q(x.postOdds) + '</small>';
      const detail = x.ok
        ? '<span style="color:#4caf7a;">✅ gepostet</span><br><small>' + (x.tier === 'half' ? '' : 'Modell ' + pct(x.liveProba) + ' · ') + 'Tor-Score ' + (x.goalPoints > 0 ? '+' : '') + esc(x.goalPoints) + (x.marketProba != null ? ' · Markt ' + pct(x.marketProba) : '') + '</small>'
        : '<span style="color:#e0a040;">✖ verworfen</span><br><small>' + esc(x.reason) + (x.marketProba != null ? ' · Markt ' + pct(x.marketProba) : '') + '</small>';
      html += '<tr><td>' + hm(x.decidedAt) + '</td><td>' + esc(x.homeTeam) + ' – ' + esc(x.awayTeam) + '<br><small>' + (x.tier === 'half' ? '🟠 Half-Risiko · ' : '') + 'O' + esc(x.targetLine) + ' · Signal ' + esc(x.signalMinute) + "' · " + pct(x.signalProba) + '</small></td><td>' + detail + '</td><td>' + live + '</td></tr>';
    });
    html += '</table>';
    out.innerHTML = html;
  } catch (e) { out.textContent = e.message; }
});

document.getElementById('export-btn').addEventListener('click', async () => {
  const out = document.getElementById('confirm-out');
  try {
    const r = await fetch('/admin/api/premium-export', { headers: { 'Authorization': 'Bearer ' + pw() } });
    if (!r.ok) throw new Error('Fehler ' + r.status + ' (falsches Passwort?)');
    const csv = await r.text();
    const name = 'premium_log_' + new Date().toISOString().slice(0, 10) + '.csv';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    // Fallback for browsers that ignore blob downloads (some iPad browsers): show it to copy.
    out.innerHTML = '<div style="font-size:0.8rem;margin-bottom:6px;">' + (csv.trim().split('\\n').length - 1) +
      ' Einträge. Falls kein Download startet: Text kopieren und als ' + name + ' speichern.</div>' +
      '<textarea readonly style="width:100%;height:160px;background:#202634;color:#e6e9f0;border:1px solid #2c3444;font-size:0.7rem;">' + esc(csv) + '</textarea>';
  } catch (e) { out.textContent = e.message; }
});

document.getElementById('backup-btn').addEventListener('click', async () => {
  const out = document.getElementById('backup-out');
  out.textContent = 'Erstelle Backup …';
  try {
    const r = await fetch('/admin/api/backup', { headers: { 'Authorization': 'Bearer ' + pw() } });
    if (!r.ok) throw new Error('Fehler ' + r.status + ' (falsches Passwort?)');
    const text = await r.text();
    const data = JSON.parse(text);
    const name = 'moneybag_backup_' + new Date().toISOString().slice(0, 10) + '.json';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    out.innerHTML = 'Backup mit <b>' + data.count + '</b> Einträgen erstellt (' + esc(name) + '). Falls kein Download startet: Text kopieren und als .json speichern.' +
      '<textarea readonly style="width:100%;height:120px;margin-top:6px;background:#202634;color:#e6e9f0;border:1px solid #2c3444;font-size:0.7rem;">' + esc(text) + '</textarea>';
  } catch (e) { out.textContent = e.message; }
});

document.getElementById('restore-btn').addEventListener('click', async () => {
  const out = document.getElementById('backup-out');
  const file = document.getElementById('restore-file').files[0];
  if (!file) { out.textContent = 'Bitte zuerst eine Backup-Datei auswählen.'; return; }
  out.textContent = 'Spiele Backup ein …';
  try {
    const text = await file.text();
    const r = await fetch('/admin/api/restore', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + pw(), 'Content-Type': 'application/json' },
      body: text
    });
    const res = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(res.error || ('Fehler ' + r.status + ' (falsches Passwort?)'));
    out.textContent = res.restored + ' Einträge wiederhergestellt' + (res.expired ? ', ' + res.expired + ' bereits abgelaufene übersprungen.' : '.');
  } catch (e) { out.textContent = e.message; }
});

// Weekly results as a 1080x1350 image to post (Telegram / Instagram 4:5),
// drawn from the same numbers as the weekly report.
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - y) / 86400000 + 1) / 7);
}
function drawBilanz(s, from, to) {
  const W = 1080, H = 1350, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const font = (w, px) => w + ' ' + px + 'px -apple-system, system-ui, Segoe UI, sans-serif';
  const bg = g.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#12151c'); bg.addColorStop(1, '#1c2333');
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  const gold = '#d4a72c', text = '#e6e9f0', muted = '#8891a3', green = '#4caf7a', red = '#e06a5a';
  const d2 = d => String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0') + '.';
  const pct = t => t.n ? Math.round(t.won / t.n * 1000) / 10 : null;
  const de = v => String(v).replace('.', ',');
  g.textAlign = 'left';
  g.fillStyle = gold; g.font = font('700', 40); g.fillText('💰 MONEYBAG', 80, 120);
  g.fillStyle = text; g.font = font('800', 88); g.fillText('Wochenbilanz', 80, 230);
  g.fillStyle = muted; g.font = font('500', 40);
  g.fillText('KW ' + isoWeek(to) + ' · ' + d2(from) + '–' + d2(to) + to.getFullYear(), 80, 295);
  const total = pct(s.all);
  g.fillStyle = gold; g.font = font('800', 200);
  g.fillText(total == null ? '–' : de(total) + ' %', 70, 520);
  g.fillStyle = text; g.font = font('500', 42);
  g.fillText(s.all.n ? s.all.won + ' von ' + s.all.n + ' Tipps getroffen' : 'Noch keine abgeschlossenen Tipps', 80, 590);
  const rows = [
    ['🔥', 'High Confidence', s.premium], ['🟠', 'Half-Risiko', s.half || { n: 0, won: 0 }],
    ['⚠️', 'Risiko', s.risk, 'seit 13.10. abgeschaltet'], ['🛡️', 'Under 3.5', s.under || { n: 0, won: 0 }],
    ['🧪', 'Over 1.5 Test', s.o15 || { n: 0, won: 0 }, 'seit 21.10.'],
  ].filter(r => r[2] && r[2].n);
  let y = 700;
  rows.forEach(([icon, label, t, note]) => {
    const p = pct(t);
    g.fillStyle = text; g.font = font('600', 44); g.fillText(icon + '  ' + label, 80, y);
    if (note) {
      const x = 80 + g.measureText(icon + '  ' + label).width + 20;
      g.fillStyle = muted; g.font = font('500', 30); g.fillText(note, x, y);
      g.fillStyle = text;
    }
    g.textAlign = 'right'; g.font = font('700', 42); g.fillText(de(p) + ' %', 1000, y);
    g.fillStyle = muted; g.font = font('500', 34); g.fillText(t.won + '/' + t.n + '   ', 1000 - g.measureText(de(p) + ' %').width - 70, y);
    g.textAlign = 'left';
    g.fillStyle = '#2c3444'; g.fillRect(80, y + 24, 920, 16);
    g.fillStyle = p >= 70 ? green : p >= 55 ? gold : red; g.fillRect(80, y + 24, 920 * p / 100, 16);
    y += 112;
  });
  if (s.priced >= 20) {
    const roi = s.staked ? Math.round(s.profit / s.staked * 1000) / 10 : 0;
    const sign = s.profit >= 0 ? '+' : '';
    g.fillStyle = s.profit >= 0 ? green : red; g.font = font('700', 42);
    g.fillText('💶 ' + sign + de(s.profit) + ' Einheiten (Rendite ' + sign + de(roi) + ' %)', 80, y + 30);
    g.fillStyle = muted; g.font = font('500', 30);
    g.fillText('bei ' + s.priced + (s.priced === 1 ? ' Tipp' : ' Tipps') + ' mit Quote ab Mindestquote', 80, y + 75);
  }
  g.fillStyle = '#2c3444'; g.fillRect(80, 1232, 920, 2);
  g.fillStyle = muted; g.font = font('500', 28);
  g.fillText('Automatisch aus dem Live-Spielstand erfasst – Treffer und Verluste.', 80, 1278);
  g.fillText('18+ · Keine Gewinngarantie · Hilfe: check-dein-spiel.de', 80, 1316);
  return c;
}
document.getElementById('img-btn').addEventListener('click', async () => {
  const out = document.getElementById('img-out');
  out.textContent = 'Erstelle Grafik …';
  try {
    const r = await fetch('/admin/api/results?days=7', { headers: { 'Authorization': 'Bearer ' + pw() } });
    if (!r.ok) throw new Error('Fehler ' + r.status + ' (falsches Passwort?)');
    const d = await r.json();
    const to = new Date(), from = new Date(to.getTime() - 7 * 86400000);
    const url = drawBilanz(d.summary, from, to).toDataURL('image/png');
    const name = 'moneybag_bilanz_' + to.toISOString().slice(0, 10) + '.png';
    out.innerHTML = '<div style="font-size:0.8rem;color:#8891a3;margin-bottom:6px;">Auf dem iPad: Bild lange gedrückt halten → „Zu Fotos hinzufügen“. Oder <a href="' + url + '" download="' + name + '" style="color:#d4a72c;">herunterladen</a>.</div>' +
      '<img src="' + url + '" style="width:100%;border-radius:6px;">';
  } catch (e) { out.textContent = e.message; }
});

async function loadResults(days) {
  const out = document.getElementById('res-out');
  out.textContent = 'Lade …';
  try {
    const r = await fetch('/admin/api/results?days=' + days, { headers: { 'Authorization': 'Bearer ' + pw() } });
    if (!r.ok) throw new Error('Fehler ' + r.status + ' (falsches Passwort?)');
    const d = await r.json();
    const s = d.summary;
    const t = x => x.n ? x.won + '/' + x.n + ' = ' + (Math.round(x.won / x.n * 1000) / 10) + ' %' : '–';
    let html = '<div style="font-size:0.9rem;line-height:1.6;">High Confidence: <b>' + t(s.premium) + '</b><br>Half-Risiko: <b>' + t(s.half || {n:0}) + '</b><br>Risiko: <b>' + t(s.risk) + '</b><br>Under 3.5: <b>' + t(s.under || {n:0}) + '</b><br>Over 1.5 Test: <b>' + t(s.o15 || {n:0}) + '</b><br>Gesamt: <b>' + t(s.all) + '</b>';
    if (s.priced) html += '<br>Mit Quote ab Mindestquote (' + s.priced + (s.priced === 1 ? ' Tipp' : ' Tipps') + '): <b>' + (s.profit >= 0 ? '+' : '') + s.profit + ' Einheiten</b>';
    html += '<br><span style="color:#8891a3;">Noch offen: ' + d.open.length + '</span></div>';
    html += '<details style="margin-top:8px;"><summary>Vorschau Wochenbilanz-Post</summary><pre style="white-space:pre-wrap;font-size:0.8rem;background:#202634;padding:8px;border-radius:4px;">' + esc(d.reportPreview) + '</pre></details>';
    if (d.rows.length) {
      html += '<table style="margin-top:8px;"><tr><th>Zeit</th><th>Spiel</th><th>Ergebnis</th><th>Quote</th></tr>';
      d.rows.slice(0, 100).forEach(x => {
        const res = x.tier === 'under'
          ? (x.result === 'won' ? '<span style="color:#4caf7a;">✅ ≤1 Tor</span>' : x.result === 'lost' ? '<span style="color:#e0a040;">✖ 2. Tor ' + (x.resultMinute != null ? x.resultMinute + "'" : '') + '</span>' : '<span style="color:#8891a3;">– unklar</span>')
          : x.result === 'won' ? '<span style="color:#4caf7a;">✅ Tor ' + (x.resultMinute != null ? x.resultMinute + "'" : '') + '</span>'
          : x.result === 'lost' ? '<span style="color:#e0a040;">✖ kein Tor</span>' : '<span style="color:#8891a3;">– unklar</span>';
        const q = x.quote != null ? Number(x.quote).toFixed(2) + (x.betPlaced ? '' : ' (unter ' + Number(x.minQuote).toFixed(2) + ')') : '–';
        html += '<tr><td>' + hm(x.settledAt) + '</td><td>' + esc(x.home) + ' – ' + esc(x.away) + '<br><small>' + (x.tier === 'risk' ? 'Risiko' : x.tier === 'half' ? 'Half-Risiko' : x.tier === 'under' ? 'Under' : x.tier === 'o15' ? 'O1.5 Test' : 'Premium') + (x.tier === 'under' ? ' · U' : ' · O') + esc(x.line) + ' · ' + esc(x.minute) + "' · " + esc(x.units) + ' E.</small></td><td>' + res + (x.profit != null ? '<br><small>' + (x.profit >= 0 ? '+' : '') + x.profit + ' E.</small>' : '') + '</td><td>' + q + '</td></tr>';
      });
      html += '</table>';
    }
    out.innerHTML = html;
  } catch (e) { out.textContent = e.message; }
}
let testArmed = false;
document.getElementById('test-btn').addEventListener('click', async () => {
  const out = document.getElementById('test-out');
  const btn = document.getElementById('test-btn');
  if (!testArmed) {
    testArmed = true;
    btn.textContent = 'Wirklich senden? Nochmal tippen';
    out.textContent = 'Der Test-Post geht an alle Abonnenten (deutlich als TEST markiert).';
    setTimeout(() => { testArmed = false; btn.textContent = 'Test-Signal an Premium-Kanal senden'; }, 8000);
    return;
  }
  testArmed = false;
  btn.textContent = 'Test-Signal an Premium-Kanal senden';
  out.textContent = 'Sende …';
  try {
    const r = await fetch('/admin/api/test-post', { method: 'POST', headers: { 'Authorization': 'Bearer ' + pw() } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || ('Fehler ' + r.status + ' (falsches Passwort?)'));
    out.textContent = (d.sent ? '✅ Gesendet. ' : '❌ Telegram hat nicht angenommen. ') +
      (d.feedOk ? 'Live-Feed erreichbar (' + d.matches + ' Spiele)' + (d.match ? ', Beispiel: ' + d.match : '') + '.' : '⚠️ Live-Feed von Cloudflare NICHT erreichbar.');
  } catch (e) { out.textContent = e.message; }
});

let o05Armed = false;
document.getElementById('test-o05-btn').addEventListener('click', async () => {
  const out = document.getElementById('test-o05-out');
  const btn = document.getElementById('test-o05-btn');
  if (!o05Armed) {
    o05Armed = true;
    btn.textContent = 'Wirklich senden? Nochmal tippen';
    out.textContent = 'Der Test-Post geht an alle Abonnenten (deutlich als TEST markiert).';
    setTimeout(() => { o05Armed = false; btn.textContent = 'Test Over 0.5 senden'; }, 8000);
    return;
  }
  o05Armed = false;
  btn.textContent = 'Test Over 0.5 senden';
  out.textContent = 'Sende …';
  try {
    const r = await fetch('/admin/api/test-post?line=0.5', { method: 'POST', headers: { 'Authorization': 'Bearer ' + pw() } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || ('Fehler ' + r.status + ' (falsches Passwort?)'));
    out.textContent = (d.sent ? '✅ Gesendet. ' : '❌ Telegram hat nicht angenommen. ') +
      (d.feedOk ? 'Beispiel: ' + (d.match || 'gerade kein 0-0-Spiel') + '.' : '⚠️ Live-Feed von Cloudflare NICHT erreichbar.');
  } catch (e) { out.textContent = e.message; }
});

document.getElementById('free-fill-btn').addEventListener('click', async () => {
  const out = document.getElementById('free-fill-out');
  out.textContent = 'Poste …';
  try {
    const r = await fetch('/admin/api/free-backfill', { method: 'POST', headers: { 'Authorization': 'Bearer ' + pw() } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || ('Fehler ' + r.status + ' (falsches Passwort?)'));
    out.textContent = d.posted ? '✅ ' + d.posted + ' Ergebnis(se) in ' + d.channel + ' gepostet.' : (d.available ? '❌ Telegram hat abgelehnt.' : 'Keine neuen entschiedenen Signale aus den letzten 48 Stunden (alle schon gepostet).');
  } catch (e) { out.textContent = e.message; }
});

document.getElementById('test-free-btn').addEventListener('click', async () => {
  const out = document.getElementById('test-free-out');
  out.textContent = 'Sende …';
  try {
    const r = await fetch('/admin/api/test-post?target=free', { method: 'POST', headers: { 'Authorization': 'Bearer ' + pw() } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || ('Fehler ' + r.status + ' (falsches Passwort?)'));
    out.textContent = d.sent ? '✅ Im Gratis-Kanal ' + d.channel + ' angekommen.' : '❌ Telegram hat abgelehnt – ist der Bot Admin in ' + d.channel + ' mit dem Recht „Nachrichten senden“?';
  } catch (e) { out.textContent = e.message; }
});

let underArmed = false;
document.getElementById('test-under-btn').addEventListener('click', async () => {
  const out = document.getElementById('test-under-out');
  const btn = document.getElementById('test-under-btn');
  if (!underArmed) {
    underArmed = true;
    btn.textContent = 'Wirklich senden? Nochmal tippen';
    out.textContent = 'Der Test-Post geht an alle Abonnenten (deutlich als TEST markiert).';
    setTimeout(() => { underArmed = false; btn.textContent = 'Test Under 3.5 senden'; }, 8000);
    return;
  }
  underArmed = false;
  btn.textContent = 'Test Under 3.5 senden';
  out.textContent = 'Sende …';
  try {
    const r = await fetch('/admin/api/test-post?tier=under', { method: 'POST', headers: { 'Authorization': 'Bearer ' + pw() } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || ('Fehler ' + r.status + ' (falsches Passwort?)'));
    out.textContent = (d.sent ? '✅ Gesendet. ' : '❌ Telegram hat nicht angenommen. ') +
      (d.feedOk ? 'Beispiel: ' + (d.match || 'gerade kein Spiel mit 2 Toren') + '.' : '⚠️ Live-Feed von Cloudflare NICHT erreichbar.');
  } catch (e) { out.textContent = e.message; }
});

let halfArmed = false;
document.getElementById('test-half-btn').addEventListener('click', async () => {
  const out = document.getElementById('test-half-out');
  const btn = document.getElementById('test-half-btn');
  if (!halfArmed) {
    halfArmed = true;
    btn.textContent = 'Wirklich senden? Nochmal tippen';
    out.textContent = 'Der Test-Post geht an alle Abonnenten (deutlich als TEST markiert).';
    setTimeout(() => { halfArmed = false; btn.textContent = 'Test Half-Risiko senden'; }, 8000);
    return;
  }
  halfArmed = false;
  btn.textContent = 'Test Half-Risiko senden';
  out.textContent = 'Sende …';
  try {
    const r = await fetch('/admin/api/test-post?tier=half', { method: 'POST', headers: { 'Authorization': 'Bearer ' + pw() } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || ('Fehler ' + r.status + ' (falsches Passwort?)'));
    out.textContent = (d.sent ? '✅ Gesendet. ' : '❌ Telegram hat nicht angenommen. ') +
      (d.feedOk ? 'Beispiel: ' + (d.match || 'kein laufendes Spiel') + '.' : '⚠️ Live-Feed von Cloudflare NICHT erreichbar.');
  } catch (e) { out.textContent = e.message; }
});

function u35Part(label, x) {
  const p = v => v == null ? '–' : Math.round(v * 1000) / 10 + ' %';
  return '<tr><td>' + label + '</td><td>' + x.won + '/' + x.n + '<br><small>' + p(x.rate) + '</small></td><td>' + p(x.marketAvg) + '</td><td>' +
    (x.line35 ? x.line35 + ' × Ø ' + x.underAvg35 + '<br><small>' + (x.profit35 >= 0 ? '+' : '') + x.profit35 + ' E.</small>' : '–') + '</td></tr>';
}
document.getElementById('u35-btn').addEventListener('click', async () => {
  const out = document.getElementById('u35-out');
  out.textContent = 'Lade …';
  try {
    const r = await fetch('/admin/api/u35?days=14', { headers: { 'Authorization': 'Bearer ' + pw() } });
    if (!r.ok) throw new Error('Fehler ' + r.status + ' (falsches Passwort?)');
    const d = await r.json();
    const s = d.summary;
    let html = '<table><tr><th></th><th>Under 3.5</th><th>Markt</th><th>Linie 3,5</th></tr>' +
      u35Part('Alle', s.all) + u35Part('ohne Premium', s.nonPremium) + u35Part('Premium', s.premium) +
      (s.byGoalScore || []).map(b => u35Part('Tor-Score ' + b.label + '<br><small>Rückrechnung ' + Math.round(b.backtest * 100) + ' % · lohnt ab ' + (1 / b.backtest).toFixed(2) + '</small>', b)).join('') + '</table>' +
      '<div style="font-size:0.8rem;color:#8891a3;margin-top:6px;">Noch offen: ' + s.open + ' · nicht im Feed: ' + s.void + ' · unklar (nicht bis Minute 85 gesehen): ' + (s.unclear || 0) + ' · lohnt ab Quote ≈ 1,56 (Rückrechnung)</div>';
    if (d.rows.length) {
      html += '<table style="margin-top:8px;"><tr><th>Zeit</th><th>Spiel</th><th>Linie</th><th>Ergebnis</th></tr>';
      d.rows.slice(0, 60).forEach(x => {
        const st = x.status === 'won' ? '<span style="color:#4caf7a;">✅ ≤1 Tor</span>' : x.status === 'lost' ? '<span style="color:#e0a040;">✖ 2+ Tore' + (x.lostMinute != null ? ' (' + x.lostMinute + "')" : '') + '</span>' : x.status === 'open' ? 'läuft' : x.status === 'unclear' ? '<span style="color:#8891a3;">? nicht bis Ende gesehen</span>' : '–';
        html += '<tr><td>' + hm(new Date(x.at).toISOString()) + '</td><td>' + esc(x.home) + ' – ' + esc(x.away) + '<br><small>' + esc(x.minute) + "'" + (x.premium ? ' · Premium' : '') + (x.gs != null ? ' · TS ' + (x.gs > 0 ? '+' : '') + esc(x.gs) : '') + '</small></td><td>' +
          (x.line != null ? esc(x.line) + '<br><small>U ' + esc(x.under) + (x.marketU35 != null ? ' · ' + pct(x.marketU35) : '') + '</small>' : '–') + '</td><td>' + st + '</td></tr>';
      });
      html += '</table>';
    }
    out.innerHTML = html;
  } catch (e) { out.textContent = e.message; }
});
document.getElementById('u35-csv-btn').addEventListener('click', async () => {
  const out = document.getElementById('u35-out');
  try {
    const r = await fetch('/admin/api/u35?days=60&format=csv', { headers: { 'Authorization': 'Bearer ' + pw() } });
    if (!r.ok) throw new Error('Fehler ' + r.status + ' (falsches Passwort?)');
    const csv = await r.text();
    const name = 'under35_log_' + new Date().toISOString().slice(0, 10) + '.csv';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    out.innerHTML = '<div style="font-size:0.8rem;margin-bottom:6px;">Falls kein Download startet: Text kopieren und als ' + name + ' speichern.</div>' +
      '<textarea readonly style="width:100%;height:160px;background:#202634;color:#e6e9f0;border:1px solid #2c3444;font-size:0.7rem;">' + esc(csv) + '</textarea>';
  } catch (e) { out.textContent = e.message; }
});

async function fillUnclear(apply) {
  const out = document.getElementById('fill-out');
  const file = document.getElementById('fill-file').files[0];
  if (!file) { out.textContent = 'Bitte zuerst die CSV-Datei auswählen.'; return; }
  out.textContent = apply ? 'Trage nach …' : 'Prüfe …';
  try {
    const r = await fetch('/admin/api/fill-unclear' + (apply ? '?apply=1' : ''), {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + pw(), 'Content-Type': 'text/csv' }, body: await file.text()
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || ('Fehler ' + r.status + ' (falsches Passwort?)'));
    const won = d.filled.filter(x => x.result === 'won').length;
    let html = '<div>' + d.cards + ' Karten in der Datei · ' + d.voids + ' unklare Tipps · <b>' + d.filled.length + (d.applied ? ' nachgetragen' : ' gefunden') + '</b> (' + won + ' Treffer, ' + (d.filled.length - won) + ' verloren) · ' + d.missing + ' nicht in der Datei</div>';
    html += d.filled.slice(0, 60).map(x => '<div style="font-size:0.8rem;">' + (x.result === 'won' ? '✅ ' : '❌ ') + esc(x.home) + ' – ' + esc(x.away) + ' · ' + (x.tier === 'under' ? 'U' : 'O') + esc(x.line) + (x.resultMinute != null ? ' · Tor ' + esc(x.resultMinute) + "'" : '') + '</div>').join('');
    if (d.applied) html += '<div style="margin-top:6px;">Fertig. Ergebnis-Seite zeigt es in max. 5 Minuten.</div>';
    else if (d.filled.length) html += '<div style="margin-top:6px;">Passt das? Dann auf „Übernehmen“ tippen.</div>';
    out.innerHTML = html;
  } catch (e) { out.textContent = e.message; }
}
document.getElementById('fill-prev-btn').addEventListener('click', () => fillUnclear(false));
document.getElementById('fill-apply-btn').addEventListener('click', () => fillUnclear(true));
document.getElementById('res7-btn').addEventListener('click', () => loadResults(7));
document.getElementById('res30-btn').addEventListener('click', () => loadResults(30));

document.getElementById('list-btn').addEventListener('click', async () => {
  const out = document.getElementById('list-out');
  out.textContent = 'Lade …';
  try {
    const r = await fetch('/admin/api/list', { headers: { 'Authorization': 'Bearer ' + pw() } });
    if (!r.ok) throw new Error('Fehler ' + r.status);
    const rows = await r.json();
    if (!rows.length) { out.textContent = 'Keine Zugänge.'; return; }
    let html = '<table><tr><th>Token</th><th>Status</th><th>Läuft ab</th></tr>';
    rows.forEach(row => {
      const expired = row.expiresAt < Date.now();
      html += '<tr><td>' + row.token.slice(0,8) + '…</td><td>' + row.status + (expired ? ' (abgelaufen)' : '') + '</td><td>' + new Date(row.expiresAt).toLocaleString('de-DE') + '</td></tr>';
    });
    html += '</table>';
    out.innerHTML = html;
  } catch (e) { out.textContent = e.message; }
});
</script>
</body></html>`);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // --- Public results page (no access token needed) ---
    if (url.pathname === "/ergebnisse" || url.pathname === "/ergebnisse/") {
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
      return resultsPage(request, env, ctx);
    }

    // --- Admin ---
    if (url.pathname === "/admin") {
      return handleAdminPage();
    }
    if (url.pathname.startsWith("/admin/api/")) {
      const blocked = await adminGate(request, env);
      if (blocked) return blocked;
    }

    if (url.pathname === "/admin/api/create" && request.method === "POST") {
      if (!isAdminAuthed(request, env)) return jsonResponse({ error: "unauthorized" }, 401);
      const body = await request.json().catch(() => ({}));
      const hours = Number(body.hours) > 0 ? Number(body.hours) : 24;
      const token = randomToken();
      const record = {
        token,
        status: "trial",
        createdAt: Date.now(),
        expiresAt: Date.now() + hours * 60 * 60 * 1000,
      };
      await putAccess(env, token, record);
      const link = `${url.origin}/?t=${token}`;
      return jsonResponse({ token, url: link, expiresAt: record.expiresAt });
    }

    if (url.pathname === "/admin/api/extend" && request.method === "POST") {
      if (!isAdminAuthed(request, env)) return jsonResponse({ error: "unauthorized" }, 401);
      const body = await request.json().catch(() => ({}));
      // Accept the bare token or the whole access link.
      const rawToken = String(body.token || "").trim();
      const token = (rawToken.match(/[0-9a-f]{32}/) || [rawToken])[0];
      const days = Number(body.days) > 0 ? Number(body.days) : 30;
      if (!token) return jsonResponse({ error: "token fehlt" }, 400);
      if (!TOKEN_RE.test(token)) return jsonResponse({ error: "Ungültiger Token (32 Zeichen 0-9/a-f erwartet)." }, 400);
      const existing = (await getAccess(env, token)) || {
        token,
        status: "trial",
        createdAt: Date.now(),
        expiresAt: Date.now(),
      };
      const base = Math.max(existing.expiresAt, Date.now());
      const record = { ...existing, token, status: "paid", expiresAt: base + days * DAY_MS };
      await putAccess(env, token, record);
      return jsonResponse(record);
    }

    if (url.pathname === "/admin/api/list" && request.method === "GET") {
      if (!isAdminAuthed(request, env)) return jsonResponse({ error: "unauthorized" }, 401);
      const list = await env.ACCESS_KV.list();
      const rows = [];
      for (const key of list.keys) {
        const raw = await env.ACCESS_KV.get(key.name);
        if (raw) {
          try {
            const rec = JSON.parse(raw);
            // The same KV namespace also holds signal logs and queues;
            // only access-token records have a token and an expiry.
            if (rec && typeof rec.token === "string" && rec.expiresAt) rows.push(rec);
          } catch (e) {}
        }
      }
      rows.sort((a, b) => b.createdAt - a.createdAt);
      return jsonResponse(rows);
    }

    if (url.pathname === "/admin/api/premium-log" && request.method === "GET") {
      if (!isAdminAuthed(request, env)) return jsonResponse({ error: "unauthorized" }, 401);
      const rows = [];
      let cursor;
      do {
        const list = await env.ACCESS_KV.list({ prefix: "premium:fwd:", cursor });
        for (const key of list.keys) {
          const raw = await env.ACCESS_KV.get(key.name);
          if (raw) {
            try {
              rows.push(JSON.parse(raw));
            } catch (e) {}
          }
        }
        cursor = list.list_complete ? undefined : list.cursor;
      } while (cursor);
      rows.sort((a, b) => b.forwardedAt.localeCompare(a.forwardedAt));
      return jsonResponse(rows);
    }

    if (url.pathname === "/admin/api/risk-log" && request.method === "GET") {
      if (!isAdminAuthed(request, env)) return jsonResponse({ error: "unauthorized" }, 401);
      const rows = [];
      let cursor;
      do {
        const list = await env.ACCESS_KV.list({ prefix: "risk:fwd:", cursor });
        for (const key of list.keys) {
          const raw = await env.ACCESS_KV.get(key.name);
          if (raw) {
            try {
              rows.push(JSON.parse(raw));
            } catch (e) {}
          }
        }
        cursor = list.list_complete ? undefined : list.cursor;
      } while (cursor);
      rows.sort((a, b) => b.forwardedAt.localeCompare(a.forwardedAt));
      return jsonResponse(rows);
    }

    // Full KV backup: every key with its value and expiry, as one JSON file.
    if (url.pathname === "/admin/api/backup" && request.method === "GET") {
      if (!isAdminAuthed(request, env)) return jsonResponse({ error: "unauthorized" }, 401);
      const entries = [];
      let cursor;
      do {
        const list = await env.ACCESS_KV.list({ cursor });
        for (const key of list.keys) {
          const value = await env.ACCESS_KV.get(key.name);
          if (value != null) entries.push({ key: key.name, value, expiration: key.expiration || null });
        }
        cursor = list.list_complete ? undefined : list.cursor;
      } while (cursor);
      const body = JSON.stringify({ format: "moneybag-kv-backup", version: 1, createdAt: new Date().toISOString(), count: entries.length, entries });
      return new Response(body, {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="moneybag_backup_${new Date().toISOString().slice(0, 10)}.json"`,
        },
      });
    }

    // Restore from such a backup. Writes every entry back (overwriting keys
    // with the same name); never deletes anything. Already-expired entries
    // are skipped.
    if (url.pathname === "/admin/api/restore" && request.method === "POST") {
      if (!isAdminAuthed(request, env)) return jsonResponse({ error: "unauthorized" }, 401);
      const backup = await request.json().catch(() => null);
      if (!backup || backup.format !== "moneybag-kv-backup" || !Array.isArray(backup.entries)) {
        return jsonResponse({ error: "Keine gültige Backup-Datei." }, 400);
      }
      const nowSec = Math.floor(Date.now() / 1000);
      let restored = 0;
      let expired = 0;
      for (const e of backup.entries) {
        if (!e || typeof e.key !== "string" || typeof e.value !== "string") continue;
        if (e.expiration && e.expiration <= nowSec + 60) {
          expired++;
          continue;
        }
        await env.ACCESS_KV.put(e.key, e.value, e.expiration ? { expiration: e.expiration } : undefined);
        restored++;
      }
      return jsonResponse({ ok: true, restored, expired });
    }

    if (url.pathname === "/admin/api/premium-export" && request.method === "GET") {
      if (!isAdminAuthed(request, env)) return jsonResponse({ error: "unauthorized" }, 401);
      return new Response(await premiumExportCsv(env), {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="premium_log_${new Date().toISOString().slice(0, 10)}.csv"`,
        },
      });
    }

    // End-to-end test of the premium pipeline from Cloudflare: fetch the live
    // feed (token + cookie), build a post for a running match exactly like the
    // live check does, and send it to the premium channel clearly marked as a
    // test. Not tracked, not logged, not counted in the results.
    // Fill the free channel by hand: the 3 most recently settled premium
    // tips of the last 48 h (won or lost - never chosen by result), each
    // posted at most once.
    if (url.pathname === "/admin/api/free-backfill" && request.method === "POST") {
      if (!isAdminAuthed(request, env)) return jsonResponse({ error: "unauthorized" }, 401);
      const rows = (await listResults(env, Date.now() - 2 * DAY_MS))
        .filter((r) => (r.result === "won" || r.result === "lost") && ["premium", "half", "under", "o15"].includes(r.tier));
      const picked = [];
      for (const r of rows) {
        if (picked.length >= FREE_PER_DAY) break;
        const doneKey = `free:done:${r.settledAt}:${normTeam(r.home)}`;
        if (await env.ACCESS_KV.get(doneKey)) continue;
        picked.push([r, doneKey]);
      }
      const today = new Date().toISOString().slice(0, 10);
      let posted = 0;
      for (const [r, doneKey] of picked.reverse()) {
        const day = (r.postedAt || r.settledAt).slice(0, 10);
        const when = day === today ? "von heute" : `vom ${day.slice(8, 10)}.${day.slice(5, 7)}.`;
        const sent = await sendTelegramMessage(env, freeChannel(env),
          freeSignalText({ ...r, under: r.tier === "under" }, r.result, env, when));
        if (sent) {
          posted++;
          await env.ACCESS_KV.put(doneKey, "1", { expirationTtl: 7 * 24 * 60 * 60 });
        }
      }
      return jsonResponse({ posted, available: picked.length, channel: freeChannel(env) });
    }

    if (url.pathname === "/admin/api/test-post" && request.method === "POST" && url.searchParams.get("target") === "free") {
      if (!isAdminAuthed(request, env)) return jsonResponse({ error: "unauthorized" }, 401);
      // Checks that the bot can post in the free channel (must be admin there).
      const sample = { tier: "premium", line: 2.5, home: "Heimteam", away: "Gastteam", minute: 58, resultMinute: 74 };
      const sent = await sendTelegramMessage(env, freeChannel(env),
        "🧪 TEST – so sehen die Gratis-Posts aus (Beispieldaten)\n\n" + freeSignalText(sample, "won", env));
      return jsonResponse({ sent: !!sent, channel: freeChannel(env) });
    }

    if (url.pathname === "/admin/api/test-post" && request.method === "POST") {
      if (!isAdminAuthed(request, env)) return jsonResponse({ error: "unauthorized" }, 401);
      if (!env.PREMIUM_CHANNEL_ID || !env.TELEGRAM_BOT_TOKEN) return jsonResponse({ error: "Premium-Kanal oder Bot-Token fehlt." }, 500);
      const feed = await fetchFeed();
      const feedOk = Array.isArray(feed);
      let text;
      let matchInfo = null;
      if (url.searchParams.get("tier") === "under") {
        // Same layout as a real Under 3.5 tip, on the live 2-goal match
        // closest to minute 58. Not tracked or logged.
        let wouldPass = null;
        if (feedOk) {
          const live = feed
            .map((m) => ({ m, s: liveSnapshot(m) }))
            .filter((x) => x.s.minute != null && x.s.minute >= 20 && x.s.minute <= 85 && x.s.goals === 2);
          live.sort((a, b) => Math.abs(a.s.minute - 58) - Math.abs(b.s.minute - 58));
          const pick = live[0];
          if (pick) {
            const s = pick.s;
            const gs = goalScore(s).points;
            const wr = UNDER_WR;
            const mq = minQuote(wr);
            const odds = oddsSnapshot(pick.m);
            wouldPass = gs <= UNDER_MAX_GOAL_POINTS && s.redCards === 0 && underOddsOk(odds, mq);
            matchInfo = `${pick.m.h} – ${pick.m.a} (${s.minute}' ${s.score})`;
            text = [
              "🧪 TEST – kein Tipp, bitte nicht setzen",
              `🛡️ Under 3.5 Tore – mit Vorsicht setzen (Tor-Score ${gs > 0 ? "+" + gs : gs} · Live-Log ${Math.round(wr * 100)}%)`,
              "",
              `🏆 ${pick.m.l || ""}`,
              `⚽ ${pick.m.h} ${s.score} ${pick.m.a}`,
              `⏱ ${s.minute}'`,
              `📡 Radar X: ${s.radar != null ? s.radar : "–"}`,
              "🎯 Tipp: Under 3.5 Tore (gewinnt, wenn höchstens noch 1 Tor fällt)",
              odds ? underQuoteLine(odds) : null,
              "",
              `💶 Nur setzen ab Quote ${fmtQuote(mq)} (Under 3.5) · Einsatz: ${String(UNITS_UNDER).replace(".", ",")} Einheiten`,
              "",
              `Echt gepostet wird nur bei Tor-Score ≤ ${UNDER_MAX_GOAL_POINTS}, Live-Linie ≤ 3,5 (bei 3,5 Quote ab Mindestquote). Dieses Spiel: ${wouldPass ? "würde passen" : "würde nicht passen"}.`,
            ].filter((x) => x != null).join("\n");
          } else {
            text = `🧪 TEST Under 3.5 – kein Tipp\n\nLive-Feed erreichbar (${feed.length} Spiele), aber gerade kein laufendes Spiel mit 2 Toren.`;
          }
        } else {
          text = "🧪 TEST Under 3.5 – kein Tipp\n\n⚠️ Live-Feed von Cloudflare NICHT erreichbar. Under-Tipps werden in diesem Zustand übersprungen.";
        }
        const sent = await sendTelegramMessage(env, env.PREMIUM_CHANNEL_ID, text);
        return jsonResponse({ sent: !!sent, feedOk, matches: feedOk ? feed.length : 0, match: matchInfo, wouldPass });
      }
      if (url.searchParams.get("tier") === "half") {
        // Same layout as a real Half-Risiko post, on the live match closest
        // to minute 68. Not tracked or logged.
        let wouldPass = null;
        if (feedOk) {
          const live = feed
            .map((m) => ({ m, s: liveSnapshot(m) }))
            .filter((x) => x.s.minute != null && x.s.minute >= 20 && x.s.minute <= 89);
          live.sort((a, b) => Math.abs(a.s.minute - HALF_MIN_MINUTE) - Math.abs(b.s.minute - HALF_MIN_MINUTE));
          const pick = live[0];
          if (pick) {
            const s = pick.s;
            const line = s.goals + 0.5;
            const gs = goalScore(s);
            const odds = oddsSnapshot(pick.m);
            wouldPass = s.minute >= HALF_MIN_MINUTE && s.minute < RISK_MINUTE && gs.points >= HALF_MIN_GOAL_POINTS && s.redCards === 0;
            matchInfo = `${pick.m.h} – ${pick.m.a} (${s.minute}' ${s.score})`;
            text = [
              "🧪 TEST – kein Tipp, bitte nicht setzen",
              `🟠 Half-Risiko-Signal (Minute ${s.minute}' · Tor-Score ${gs.points})`,
              "",
              `🏆 ${pick.m.l || ""}`,
              `⚽ ${pick.m.h} ${s.score} ${pick.m.a}`,
              `🎯 Beispiel-Ziel: Over ${line}`,
              `📡 Radar X: ${s.radar != null ? s.radar : "–"}`,
              odds ? `Quote: ${oddsText(odds)}` : null,
              "",
              stakeAdvice(line, minQuote(HALF_WR), UNITS_HALF, odds),
              "",
              `Echt gepostet wird nur bei Minute 68–69 und Tor-Score ≥ ${HALF_MIN_GOAL_POINTS}. Dieses Spiel: ${wouldPass ? "würde passen" : "würde nicht passen"}.`,
            ].filter((x) => x != null).join("\n");
          } else {
            text = `🧪 TEST Half-Risiko – kein Tipp\n\nLive-Feed erreichbar (${feed.length} Spiele), aber gerade kein laufendes Spiel.`;
          }
        } else {
          text = "🧪 TEST Half-Risiko – kein Tipp\n\n⚠️ Live-Feed von Cloudflare NICHT erreichbar. Half-Risiko-Signale werden in diesem Zustand übersprungen.";
        }
        const sent = await sendTelegramMessage(env, env.PREMIUM_CHANNEL_ID, text);
        return jsonResponse({ sent: !!sent, feedOk, matches: feedOk ? feed.length : 0, match: matchInfo, wouldPass });
      }
      // ?line=0.5: example on a live 0-0 match near minute 61 (Over 0.5 cards).
      const only00 = url.searchParams.get("line") === "0.5";
      const target = only00 ? 61 : 60;
      if (feedOk) {
        const live = feed
          .map((m) => ({ m, s: liveSnapshot(m) }))
          .filter((x) => x.s.minute != null && x.s.minute >= 20 && x.s.minute <= 85 && (!only00 || x.s.goals === 0));
        live.sort((a, b) => Math.abs(a.s.minute - target) - Math.abs(b.s.minute - target));
        const pick = live[0];
        if (pick) {
          const s = pick.s;
          const line = s.goals + 0.5;
          const score = computeConfidenceScore({ targetLine: line, minute: s.minute, totalSot: s.sot, radar: s.radar, goallinePre: s.goallinePre });
          const goal = goalScore(s);
          const proba = score ? score.proba : null;
          const mq = minQuote(Math.min(proba || goal.wr || 0.75, goal.wr || 1));
          const units = goal.points >= 1 ? UNITS_STRONG : UNITS_NORMAL;
          const res = { live: s, score: score || { proba: proba || 0 }, goal, postOdds: oddsSnapshot(pick.m), signalOdds: null };
          matchInfo = `${pick.m.h} – ${pick.m.a} (${s.minute}' ${s.score})`;
          text = [
            "🧪 TEST-SIGNAL – kein Tipp, bitte nicht setzen",
            "",
            `🏆 ${pick.m.l || ""}`,
            `⚽ ${pick.m.h} ${s.score} ${pick.m.a}`,
            `🎯 Beispiel-Ziel: Over ${line}`,
            confirmationBlock(res).replace("✅ Live bestätigt nach 2 min", "✅ Live-Daten abgerufen"),
            "",
            stakeAdvice(line, mq, units, res.postOdds),
            "",
            `Live-Feed von Cloudflare erreichbar: ja (${feed.length} Spiele)`,
          ].join("\n");
        } else {
          text = `🧪 TEST – kein Tipp\n\nLive-Feed von Cloudflare erreichbar: ja (${feed.length} Spiele), aber gerade kein laufendes ${only00 ? "0-0-" : ""}Spiel zwischen 20' und 85'.`;
        }
      } else {
        text = "🧪 TEST – kein Tipp\n\n⚠️ Live-Feed von Cloudflare NICHT erreichbar. Premium-Signale werden in diesem Zustand ohne Live-Prüfung gepostet.";
      }
      const sent = await sendTelegramMessage(env, env.PREMIUM_CHANNEL_ID, text);
      return jsonResponse({ sent: !!sent, feedOk, matches: feedOk ? feed.length : 0, match: matchInfo });
    }

    if (url.pathname === "/admin/api/u35" && request.method === "GET") {
      if (!isAdminAuthed(request, env)) return jsonResponse({ error: "unauthorized" }, 401);
      const days = Math.min(Number(url.searchParams.get("days")) || 14, 180);
      const rows = await u35Rows(env, days);
      if (url.searchParams.get("format") === "csv") {
        const cols = ["time", "home", "away", "minute", "live_minute", "goals", "line", "over", "under",
          "market_u35", "premium", "proba", "goal_score", "status", "lost_minute", "seen_late"];
        const cell = (v) => {
          const t = v == null ? "" : String(v);
          return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
        };
        const lines = [cols.join(",")].concat(rows.map((r) => [
          new Date(r.at).toISOString(), r.home, r.away, r.minute, r.liveMinute, r.goals, r.line, r.over, r.under,
          r.marketU35, r.premium, r.proba, r.gs, r.status, r.lostMinute, r.seenLate,
        ].map(cell).join(",")));
        return new Response(lines.join("\n") + "\n", { headers: { "Content-Type": "text/csv; charset=utf-8" } });
      }
      return jsonResponse({ days, summary: u35Summary(rows), rows: rows.slice(0, 200) });
    }

    if (url.pathname === "/admin/api/fill-unclear" && request.method === "POST") {
      if (!isAdminAuthed(request, env)) return jsonResponse({ error: "unauthorized" }, 401);
      const res = await fillUnclear(env, await request.text(), url.searchParams.get("apply") === "1");
      return jsonResponse(res, res.error ? 400 : 200);
    }

    if (url.pathname === "/admin/api/results" && request.method === "GET") {
      if (!isAdminAuthed(request, env)) return jsonResponse({ error: "unauthorized" }, 401);
      const days = Number(url.searchParams.get("days")) || 7;
      const rows = await listResults(env, Date.now() - days * DAY_MS);
      const sum = summarize(rows);
      const to = new Date();
      return jsonResponse({
        days, summary: sum, open: await readTracked(env), rows,
        reportPreview: weeklyReportText(sum, new Date(to.getTime() - days * DAY_MS), to),
      });
    }

    if (url.pathname === "/admin/api/confirm-log" && request.method === "GET") {
      if (!isAdminAuthed(request, env)) return jsonResponse({ error: "unauthorized" }, 401);
      const [ok, rej, halfOk, halfRej] = await Promise.all([
        listLog(env, "premium:ok:"), listLog(env, "premium:rej:"), listLog(env, "half:ok:"), listLog(env, "half:rej:"),
      ]);
      const byTime = (a, b) => b.decidedAt.localeCompare(a.decidedAt);
      const confirmed = ok.concat(halfOk).sort(byTime);
      const rejected = rej.concat(halfRej).sort(byTime);
      return jsonResponse({ pending: await readPending(env), confirmed, rejected });
    }

    // --- Telegram webhook: receives every new message from the bot's chat.
    // No access-token check here - authenticity is verified via the secret
    // Telegram sends back, set once when registering the webhook.
    if (url.pathname === "/telegram-webhook" && request.method === "POST") {
      const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (!env.TELEGRAM_WEBHOOK_SECRET || secret !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response("unauthorized", { status: 401 });
      }
      const update = await request.json().catch(() => null);

      // Signal import from the channel/group, unchanged.
      const channelMsg = update && (update.channel_post || update.edited_channel_post);
      if (channelMsg && looksLikeSignalCard(channelMsg.text)) {
        await env.ACCESS_KV.put(
          LATEST_SIGNAL_KEY,
          JSON.stringify({ text: channelMsg.text, receivedAt: Date.now() })
        );

        // Auto-forward to the premium channel: high-confidence signals as
        // before, plus a "Risiko" tier for late signals (minute >= 70,
        // across all four target lines) that don't clear the confidence
        // threshold. Only the stronger part of those is forwarded
        // (minute >= RISK_MIN_MINUTE or Radar >= RISK_MIN_RADAR), still
        // clearly labeled as risk.
        if (env.PREMIUM_CHANNEL_ID) {
          const parsed = parseForConfidenceScore(channelMsg.text);
          const score = computeConfidenceScore(parsed);
          if (score && score.passes) {
            // Not posted yet: the cron trigger re-checks the match live after
            // CONFIRM_DELAY_MS and only then posts (see processPendingPremium).
            // The quote at signal time is logged so posted bets can be priced later.
            if (await claimSignal(env, parsed)) {
              const snap = await signalSnapshotFor(parsed);
              // A match missing from the guest preview cannot be checked in 2
              // minutes either: mark it "fast" so the next minute run posts it.
              // Posting stays in the cron (one run at a time): several InPlayFlux
              // strategies send the same match within seconds, and parallel
              // webhook runs got past the KV claim and posted it three times (17.10.).
              const fast = !snap.match && snap.guestFeed && !env.APIFOOTBALL_KEY;
              await queuePremium(env, channelMsg.text, parsed, score, snap.odds, fast);
            }
          } else if (
            RISK_ENABLED &&
            [0.5, 1.5, 2.5, 3.5].includes(parsed.targetLine) &&
            parsed.minute != null &&
            parsed.minute >= RISK_MINUTE &&
            (parsed.minute >= RISK_MIN_MINUTE || (parsed.radar != null && parsed.radar >= RISK_MIN_RADAR)) &&
            (await claimSignal(env, parsed))
          ) {
            const probaNote = score ? ` · Modell: ${Math.round(score.proba * 100)}%` : "";
            const snap = await signalSnapshotFor(parsed);
            const odds = snap.odds;
            const market = marketProb(snap.match, parsed.targetLine);
            const mq = minQuote(RISK_WR);
            const post = await postPremium(env, buildPremiumMessage(channelMsg.text, `⚠️ Risiko-Signal (Minute ${parsed.minute}'+${probaNote}${market != null ? ` · Markt ${Math.round(market * 100)}%` : ""})`) +
                (odds ? `\nQuote: ${oddsText(odds)}` : "") + "\n\n" +
                stakeAdvice(parsed.targetLine, mq, UNITS_RISK, odds));
            await trackSignal(env, {
              ...post,
              tier: "risk", home: parsed.homeTeam, away: parsed.awayTeam, matchId: snap.matchId,
              line: parsed.targetLine, minute: parsed.minute, minQuote: mq, units: UNITS_RISK, odds,
            });
            await logPremiumForward(env, parsed, score, "risk:fwd", { signalOdds: odds, postOdds: odds, marketProba: market });
          } else if (
            [0.5, 1.5, 2.5, 3.5].includes(parsed.targetLine) &&
            lineOn(parsed.targetLine) &&
            parsed.minute != null &&
            parsed.minute >= HALF_MIN_MINUTE &&
            parsed.minute < RISK_MINUTE
          ) {
            await maybePostHalfRisk(env, channelMsg.text, parsed, score);
          } else if (o15TestRule(parsed) && (await claimSignal(env, parsed))) {
            // Queued only; the minute cron posts it under its run lock.
            const snap = await signalSnapshotFor(parsed);
            await queuePremium(env, channelMsg.text, parsed, score, snap.odds, true, "o15");
          }
          // Shadow log only, nothing is posted.
          try {
            await logUnder35(env, parsed, score);
          } catch (e) {}
          try {
            await maybePostUnder35(env, channelMsg.text, parsed, score);
          } catch (e) {}
        }
      }

      // Two-way support chat: a visitor DMs the bot, the admin gets it
      // forwarded, and replying (Telegram "reply") to that forwarded
      // message sends the reply straight back to the visitor.
      const msg = update && update.message;
      if (msg && msg.chat && msg.chat.type === "private" && env.TELEGRAM_BOT_TOKEN && env.ADMIN_CHAT_ID) {
        const isAdmin = String(msg.chat.id) === String(env.ADMIN_CHAT_ID);
        if (isAdmin) {
          const replyTo = msg.reply_to_message && msg.reply_to_message.message_id;
          const visitorChatId = replyTo && (await env.ACCESS_KV.get(`relay:msgid:${replyTo}`));
          if (visitorChatId && msg.text) {
            await sendTelegramMessage(env, visitorChatId, msg.text);
          }
        } else if (msg.text && msg.text !== "/start") {
          const from = msg.from || {};
          const who = [from.first_name, from.last_name].filter(Boolean).join(" ") || "Unbekannt";
          const handle = from.username ? `@${from.username}` : `chat_id ${msg.chat.id}`;
          const forwarded = await sendTelegramMessage(
            env,
            env.ADMIN_CHAT_ID,
            `💬 Telegram-Kontakt von ${who} (${handle}):\n${msg.text}`
          );
          if (forwarded) {
            await env.ACCESS_KV.put(`relay:msgid:${forwarded.message_id}`, String(msg.chat.id), {
              expirationTtl: 30 * 24 * 60 * 60,
            });
          }
        } else if (msg.text === "/start") {
          await sendTelegramMessage(
            env,
            msg.chat.id,
            "Willkommen bei MoneyBag Analyst! Schreib einfach deine Frage oder dein Anliegen hier rein, wir melden uns zeitnah bei dir."
          );
        }
      }

      // Telegram just needs a fast 200 OK; the content doesn't matter.
      return new Response("ok", { status: 200 });
    }

    // --- Contact form on the access-denied page. Sends a Telegram message
    // to the admin instead of email, so no address is ever exposed client-side.
    if (url.pathname === "/api/contact" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const name = String(body.name || "").trim().slice(0, 100);
      const email = String(body.email || "").trim().slice(0, 150);
      const message = String(body.message || "").trim().slice(0, 500);
      if (!name || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return jsonResponse({ error: "Bitte Name und eine gültige E-Mail-Adresse angeben." }, 400);
      }
      if (!env.TELEGRAM_BOT_TOKEN || !env.ADMIN_CHAT_ID) {
        return jsonResponse({ error: "Kontaktformular ist gerade nicht verfügbar." }, 503);
      }

      // Basic per-IP rate limit: max 1 submission per 60 seconds.
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const rateKey = `contact_rl:${ip}`;
      if (await env.ACCESS_KV.get(rateKey)) {
        return jsonResponse({ error: "Bitte kurz warten, bevor du erneut sendest." }, 429);
      }
      await env.ACCESS_KV.put(rateKey, "1", { expirationTtl: 60 });

      const lines = [
        "📬 Neue Kontaktanfrage (MoneyBag Analyst, Formular)",
        `Name: ${name}`,
        looksLikeFakeEmail(email) ? `E-Mail: ${email} ⚠️ wirkt wie Fake-/Wegwerf-Adresse` : `E-Mail: ${email}`,
        message ? `Nachricht: ${message}` : null,
      ].filter(Boolean);
      const sent = await sendTelegramMessage(env, env.ADMIN_CHAT_ID, lines.join("\n"));
      if (!sent) {
        return jsonResponse({ error: "Senden fehlgeschlagen. Bitte später erneut versuchen." }, 502);
      }
      return jsonResponse({ ok: true });
    }

    // --- Latest-signal lookup used by the tool's "Aus Telegram importieren"
    // button. Same access gate as the main page.
    if (url.pathname === "/api/latest-signal" && request.method === "GET") {
      const resolved = await resolveAccess(request, env);
      if (!resolved.ok) return jsonResponse({ error: resolved.reason }, 403);
      const raw = await env.ACCESS_KV.get(LATEST_SIGNAL_KEY);
      if (!raw) return jsonResponse({ error: "none" }, 404);
      return jsonResponse(JSON.parse(raw));
    }

    // --- Public access-gated page ---
    const resolved = await resolveAccess(request, env);
    if (!resolved.ok) {
      return deniedPage({ reason: resolved.reason });
    }

    // Valid access. If the token came from the URL, set a cookie and
    // redirect to a clean URL so the token doesn't linger in the address bar.
    if (resolved.queryToken) {
      const maxAge = Math.floor((resolved.access.expiresAt - Date.now()) / 1000);
      const headers = new Headers({ Location: url.origin + "/" });
      headers.append(
        "Set-Cookie",
        `${COOKIE_NAME}=${encodeURIComponent(resolved.token)}; Path=/; Max-Age=${maxAge}; SameSite=Lax; Secure; HttpOnly`
      );
      return new Response(null, { status: 302, headers });
    }

    // Fetch "/" rather than "/index.html" directly - the asset server
    // 307-redirects the latter to the former (canonical URL), which would
    // just bounce the client instead of serving the page.
    const page = await env.ASSETS.fetch(request);
    const res = new Response(page.body, page);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
    return res;
  },

  // Cron triggers (wrangler.toml [triggers]): every minute live-confirms
  // queued premium signals and settles posted ones; Monday morning posts the
  // weekly result summary.
  async scheduled(event, env, ctx) {
    if (!env.PREMIUM_CHANNEL_ID || !env.TELEGRAM_BOT_TOKEN) return;
    if (event.cron === WEEKLY_CRON) ctx.waitUntil(sendWeeklyReport(env));
    else ctx.waitUntil(runMinuteJobs(env));
  },
};
