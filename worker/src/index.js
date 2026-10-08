var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.js
var COOKIE_NAME = "mb_access";
var DAY_MS = 24 * 60 * 60 * 1e3;
var LATEST_SIGNAL_KEY = "telegram:latest_signal";
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}
__name(jsonResponse, "jsonResponse");
function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" }
  });
}
__name(htmlResponse, "htmlResponse");
function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
__name(randomToken, "randomToken");
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
__name(parseCookies, "parseCookies");
function isAdminAuthed(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/);
  return !!m && m[1] === env.ADMIN_PASSWORD;
}
__name(isAdminAuthed, "isAdminAuthed");
async function getAccess(env, token) {
  if (!token) return null;
  const raw = await env.ACCESS_KV.get(token);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}
__name(getAccess, "getAccess");
async function putAccess(env, token, record) {
  const ttlSeconds = Math.max(60, Math.floor((record.expiresAt - Date.now()) / 1e3) + 30 * 24 * 60 * 60);
  await env.ACCESS_KV.put(token, JSON.stringify(record), { expirationTtl: ttlSeconds });
}
__name(putAccess, "putAccess");
async function sendTelegramMessage(env, chatId, text, replyToMessageId) {
  const payload = { chat_id: chatId, text };
  if (replyToMessageId) payload.reply_to_message_id = replyToMessageId;
  const resp = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await resp.json().catch(() => null);
  return data && data.ok ? data.result : null;
}
__name(sendTelegramMessage, "sendTelegramMessage");
var DISPOSABLE_EMAIL_DOMAINS = /* @__PURE__ */ new Set([
  "mailinator.com",
  "guerrillamail.com",
  "guerrillamail.info",
  "temp-mail.org",
  "tempmail.com",
  "10minutemail.com",
  "10minutemail.net",
  "throwawaymail.com",
  "yopmail.com",
  "trashmail.com",
  "fakeinbox.com",
  "getnada.com",
  "maildrop.cc",
  "dispostable.com",
  "sharklasers.com",
  "mailnesia.com",
  "test.com",
  "example.com",
  "fake.com",
  "none.com",
  "nomail.com",
  "noemail.com"
]);
function looksLikeFakeEmail(email) {
  const at = email.lastIndexOf("@");
  if (at === -1) return false;
  const local = email.slice(0, at).toLowerCase();
  const domain = email.slice(at + 1).toLowerCase();
  if (DISPOSABLE_EMAIL_DOMAINS.has(domain)) return true;
  const domainFirstLabel = domain.split(".")[0];
  if (local === domainFirstLabel) return true;
  return false;
}
__name(looksLikeFakeEmail, "looksLikeFakeEmail");
function looksLikeSignalCard(text) {
  if (!text) return false;
  const hasLeague = /🏆/.test(text);
  const hasTarget = /Target:/i.test(text);
  const hasTime = /\d+'\s*[\s·•]+~?\d+\s*min left/i.test(text);
  return hasLeague && hasTarget && hasTime;
}
__name(looksLikeSignalCard, "looksLikeSignalCard");
var CONFIDENCE_MODELS = {
  // targetLine -> { mean, std, coef, intercept, threshold } for
  // features [minute, total_sot, radar, goalline_pre] in that order.
  2.5: {
    // Grouped by the signal card's actual target line (not strategy name),
    // so this also covers the "... New" template variant introduced 10-04.
    mean: [57.5489, 5.8099, 320.2728, 2.9927],
    std: [4.447, 2.4613, 79.6106, 0.6112],
    coef: [-0.2769, 0.0693, 0.0257, 0.2491],
    intercept: 1.139,
    threshold: 0.8
  },
  3.5: {
    mean: [62.0784, 7.0823, 333.6862, 3.0036],
    std: [3.1719, 2.5982, 82.0626, 0.6556],
    coef: [-0.2311, 0.076, 0.0504, 0.1891],
    intercept: 0.8621,
    threshold: 0.75
  },
  1.5: {
    // Merged across all three "Over 1.5" bot-template variants.
    mean: [63.1654, 6.0279, 377.4233, 3.2012],
    std: [4.0098, 2.3251, 68.9015, 0.5045],
    coef: [-0.2786, -0.1526, 0.2299, 0.2624],
    intercept: 1.0578,
    threshold: 0.8
  },
  0.5: {
    mean: [61.2337, 3.9322, 330.3406, 3.0892],
    std: [0.5743, 2.4593, 77.9449, 0.5761],
    coef: [-0.0684, 0.1215, 0.1318, 0.4201],
    intercept: 1.0135,
    threshold: 0.8
  }
};
function parseForConfidenceScore(text) {
  const out = {};
  let m = text.match(/Target:\s*Over\s*([\d.]+)\s*Goals/i);
  if (m) out.targetLine = parseFloat(m[1]);
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
  m = text.match(/^(?:📊|📖|⚽|🥅|🏟️|🆚|⚔️)?\s*(.+?)\s+\d+\s*[–-]\s*\d+\s+(.+?)\s*$/mu);
  if (m) {
    out.homeTeam = m[1].replace(/^[^\p{L}\p{N}]+/u, "").trim();
    out.awayTeam = m[2].trim();
  }
  m = text.match(/Strike Rate:\s*(\d+)%/i);
  if (m) out.feedWR = parseInt(m[1], 10);
  return out;
}
__name(parseForConfidenceScore, "parseForConfidenceScore");
function computeConfidenceScore(parsed) {
  const model = CONFIDENCE_MODELS[parsed.targetLine];
  if (!model) return null;
  if (parsed.minute == null || parsed.totalSot == null || parsed.radar == null || parsed.goallinePre == null) {
    return null;
  }
  const x = [parsed.minute, parsed.totalSot, parsed.radar, parsed.goallinePre];
  let z = model.intercept;
  for (let i = 0; i < x.length; i++) {
    z += (x[i] - model.mean[i]) / model.std[i] * model.coef[i];
  }
  const proba = 1 / (1 + Math.exp(-z));
  return { proba, threshold: model.threshold, passes: proba >= model.threshold };
}
__name(computeConfidenceScore, "computeConfidenceScore");
function buildPremiumMessage(text, label) {
  const lines = text.split(/\r?\n/);
  const keepPatterns = [
    /🏆/,
    // league
    /Target:/i,
    // target + progress
    /\d+'[\s·•]+~?\d+\s*min left/i,
    // time
    /Radar X:/i,
    /Strike Rate:/i,
    /^[_\-─—=]{3,}$/
    // divider lines
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
  return `${label}

${kept.join("\n")}`;
}
__name(buildPremiumMessage, "buildPremiumMessage");
async function logPremiumForward(env, parsed, score, keyPrefix, extra = {}) {
  const now = /* @__PURE__ */ new Date();
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
    modelProba: score ? Math.round(score.proba * 1e3) / 1e3 : null,
    threshold: score ? score.threshold : null,
    ...extra
  };
  const key = `${keyPrefix}:${now.getTime()}:${randomToken().slice(0, 8)}`;
  await env.ACCESS_KV.put(key, JSON.stringify(record), { expirationTtl: 180 * 24 * 60 * 60 });
}
__name(logPremiumForward, "logPremiumForward");
var PENDING_KEY = "premium:pending";
var CONFIRM_DELAY_MS = 2 * 60 * 1e3;
var CONFIRM_GIVE_UP_MS = 4 * 60 * 1e3;
var FEED_URL = "https://inplayflux.com/maclarv8/GETAllMatches.php?inplay=inplay&v=";
var RISK_MINUTE = 70;
var CONFIRM_TOLERANCE = 0.05;
var RISK_MIN_MINUTE = 72;
var RISK_MIN_RADAR = 410;
var RISK_WR = 0.648;
var UNITS_STRONG = 2;
var UNITS_NORMAL = 1;
var UNITS_RISK = 0.5;
var HALF_MIN_MINUTE = 68;
var HALF_MIN_GOAL_POINTS = -7;
var HALF_WR = 0.663;
var UNITS_HALF = 0.5;
var TRACK_KEY = "track:open";
var TRACK_LOST_AFTER_MIN = 85;
var TRACK_MISSING_GRACE_MS = 10 * 60 * 1e3;
var TRACK_GIVE_UP_MS = 4 * 60 * 60 * 1e3;
var WEEKLY_CRON = "0 8 * * 1";
var RADAR_MARKET_BONUS = 124.7;
var GOAL_SCORE = {
  minPremium: -2,
  points: {
    min_58_62: -2,
    min_63_65: -5,
    min_66p: -7,
    line_lo: -2,
    line_hi: 2,
    ht_hi: 1,
    def_strong: -2,
    sot9: 2,
    recent_goal: -1,
    over_odds_hi: -1,
    fav_up1: -1
  },
  bands: [
    { min: -99, max: -9, wr: 0.547 },
    { min: -8, max: -6, wr: 0.64 },
    { min: -5, max: -3, wr: 0.703 },
    { min: -2, max: 0, wr: 0.753 },
    { min: 1, max: 99, wr: 0.821 }
  ]
};
function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}
__name(num, "num");
function pairSum(v) {
  if (!Array.isArray(v) || v.length < 2) return null;
  const a = num(v[0]);
  const b = num(v[1]);
  return a == null || b == null ? null : a + b;
}
__name(pairSum, "pairSum");
function normTeam(name) {
  return String(name || "").toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "");
}
__name(normTeam, "normTeam");
function findMatch(feed, homeTeam, awayTeam) {
  const h = normTeam(homeTeam);
  const a = normTeam(awayTeam);
  if (!h || !a) return null;
  return feed.find((m) => normTeam(m.h) === h && normTeam(m.a) === a) || feed.find((m) => {
    const mh = normTeam(m.h);
    const ma = normTeam(m.a);
    return (mh.includes(h) || h.includes(mh)) && (ma.includes(a) || a.includes(ma));
  }) || null;
}
__name(findMatch, "findMatch");
var SCANNER_URL = "https://inplayflux.com/live-scanner?page=open&lang=en";
var FEED_TOKEN_TTL_MS = 8 * 60 * 1e3;
var BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
var feedSession = null;
async function refreshFeedSession() {
  try {
    const resp = await fetch(SCANNER_URL + "&ir_token_refresh=1", {
      method: "HEAD",
      headers: { "User-Agent": BROWSER_UA },
      signal: AbortSignal.timeout(8e3)
    });
    const token = resp.headers.get("X-IR-Token");
    const setCookies = typeof resp.headers.getSetCookie === "function" ? resp.headers.getSetCookie() : [resp.headers.get("Set-Cookie") || ""];
    const cookie = setCookies.map((c) => c.split(";")[0].trim()).filter(Boolean).join("; ");
    feedSession = token && /^[a-f0-9]{64}$/i.test(token) ? { token, cookie, at: Date.now() } : null;
  } catch (e) {
    feedSession = null;
  }
  return feedSession;
}
__name(refreshFeedSession, "refreshFeedSession");
async function fetchFeedOnce(session) {
  const headers = {
    "User-Agent": BROWSER_UA,
    Referer: SCANNER_URL,
    "X-Requested-With": "XMLHttpRequest"
  };
  if (session) {
    headers["X-IR-Token"] = session.token;
    if (session.cookie) headers.Cookie = session.cookie;
  }
  const resp = await fetch(FEED_URL + Date.now(), { headers, signal: AbortSignal.timeout(8e3) });
  if (!resp.ok) return { ok: false, status: resp.status };
  const data = await resp.json();
  return Array.isArray(data) ? { ok: true, data } : { ok: false, status: 403 };
}
__name(fetchFeedOnce, "fetchFeedOnce");
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
__name(fetchFeed, "fetchFeed");
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
    at: (/* @__PURE__ */ new Date()).toISOString()
  };
}
__name(oddsSnapshot, "oddsSnapshot");
async function maybePostHalfRisk(env, text, parsed, score) {
  const snap = await signalSnapshotFor(parsed);
  const odds = snap.odds;
  const item = { id: randomToken().slice(0, 12), parsed, proba: score ? score.proba : null, signalOdds: odds, receivedAt: Date.now() };
  const reject = /* @__PURE__ */ __name(async (reason, extra = {}) => {
    await logConfirmation(env, item, { tier: "half", reason, ...extra }, "half:rej");
    return false;
  }, "reject");
  if (!snap.match) return reject("Spiel nicht im Live-Feed");
  const live = liveSnapshot(snap.match);
  if (live.goals > parsed.targetLine - 0.5) return reject(`Tor schon gefallen (${live.score})`, { live });
  if (live.redCards > 0) return reject("Rote Karte", { live });
  const gs = goalScore({ ...live, minute: live.minute != null ? live.minute : parsed.minute });
  if (gs.points < HALF_MIN_GOAL_POINTS) return reject(`Tor-Score ${gs.points} < ${HALF_MIN_GOAL_POINTS}`, { live, goal: gs });
  const mq = minQuote(HALF_WR);
  const probaNote = score ? ` \xB7 Modell: ${Math.round(score.proba * 100)}%` : "";
  await sendTelegramMessage(
    env,
    env.PREMIUM_CHANNEL_ID,
    buildPremiumMessage(text, `\u{1F7E0} Half-Risiko-Signal (Minute ${parsed.minute}' \xB7 Tor-Score ${gs.points}${probaNote})`) + (odds ? `
Quote: ${oddsText(odds)}` : "") + "\n\n" + stakeAdvice(parsed.targetLine, mq, UNITS_HALF, odds)
  );
  await trackSignal(env, {
    tier: "half",
    home: parsed.homeTeam,
    away: parsed.awayTeam,
    matchId: snap.matchId,
    line: parsed.targetLine,
    minute: parsed.minute,
    minQuote: mq,
    units: UNITS_HALF,
    odds
  });
  await logPremiumForward(env, parsed, score, "half:fwd", { signalOdds: odds, postOdds: odds, goalPoints: gs.points });
  await logConfirmation(env, item, { tier: "half", live, goal: gs, postOdds: odds }, "half:ok");
  return true;
}
__name(maybePostHalfRisk, "maybePostHalfRisk");
async function signalOddsFor(parsed) {
  return (await signalSnapshotFor(parsed)).odds;
}
__name(signalOddsFor, "signalOddsFor");
async function signalSnapshotFor(parsed) {
  const feed = await fetchFeed();
  const match = Array.isArray(feed) ? findMatch(feed, parsed.homeTeam, parsed.awayTeam) : null;
  return { odds: oddsSnapshot(match), matchId: match ? match.id : null, match };
}
__name(signalSnapshotFor, "signalSnapshotFor");
function oddsText(o) {
  return o ? `Over ${o.line != null ? o.line + " " : ""}@ ${o.over.toFixed(2)}` : null;
}
__name(oddsText, "oddsText");
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
    redCards: (num(m.hrc) || 0) + (num(m.arc) || 0)
  };
}
__name(liveSnapshot, "liveSnapshot");
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
    fav_up1: s.favMargin === 1
  };
  let points = 0;
  for (const [k, on] of Object.entries(c)) if (on) points += GOAL_SCORE.points[k];
  const band = GOAL_SCORE.bands.find((b) => points >= b.min && points <= b.max);
  return { points, wr: band ? band.wr : null };
}
__name(goalScore, "goalScore");
function confirmLive(item, match) {
  const s = liveSnapshot(match);
  const goalsAtSignal = item.parsed.targetLine - 0.5;
  if (s.minute == null) return { ok: false, reason: "keine Live-Minute im Feed", live: s };
  if (s.goals > goalsAtSignal) return { ok: false, reason: `Tor schon gefallen (${s.score})`, live: s };
  if (s.redCards > 0) return { ok: false, reason: "Rote Karte", live: s };
  if (s.minute >= RISK_MINUTE) return { ok: false, reason: `zu sp\xE4t (${s.minute}')`, live: s };
  const score = computeConfidenceScore({
    targetLine: item.parsed.targetLine,
    minute: s.minute,
    totalSot: s.sot,
    radar: s.radar,
    goallinePre: s.goallinePre != null ? s.goallinePre : item.parsed.goallinePre
  });
  if (!score) return { ok: false, reason: "Modell nicht berechenbar", live: s };
  if (score.proba < score.threshold - CONFIRM_TOLERANCE) {
    return { ok: false, reason: `Modell ${Math.round(score.proba * 100)}% < ${Math.round((score.threshold - CONFIRM_TOLERANCE) * 100)}%`, live: s, score };
  }
  const goal = goalScore(s);
  if (goal.points < GOAL_SCORE.minPremium) {
    return { ok: false, reason: `Tor-Score ${goal.points}`, live: s, score, goal };
  }
  return { ok: true, live: s, score, goal };
}
__name(confirmLive, "confirmLive");
function confirmationBlock(res) {
  const s = res.live;
  const signed = /* @__PURE__ */ __name((n) => n > 0 ? `+${n}` : String(n), "signed");
  const lines = [
    "",
    `\u2705 Live best\xE4tigt nach 2 min: ${s.minute}' \xB7 ${s.score}`,
    `Modell ${Math.round(res.score.proba * 100)}% \xB7 Tor-Score ${signed(res.goal.points)} (${Math.round(res.goal.wr * 100)}%)`
  ];
  const radarNote = s.radar != null ? `Radar ${Math.round(s.radar)}${s.overFav ? ` (davon Markt +${Math.round(RADAR_MARKET_BONUS)})` : ""}` : null;
  const oddsNote = res.postOdds ? oddsText(res.postOdds) + (res.signalOdds ? ` (bei Signal ${res.signalOdds.over.toFixed(2)})` : "") : null;
  const extra = [radarNote, s.sot != null ? `SoT ${s.sot}` : null, oddsNote].filter(Boolean);
  if (extra.length) lines.push(extra.join(" \xB7 "));
  return lines.join("\n");
}
__name(confirmationBlock, "confirmationBlock");
async function readPending(env) {
  const raw = await env.ACCESS_KV.get(PENDING_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch (e) {
    return [];
  }
}
__name(readPending, "readPending");
async function queuePremium(env, text, parsed, score, signalOdds) {
  const pending = await readPending(env);
  pending.push({ id: randomToken().slice(0, 12), text, parsed, proba: score.proba, signalOdds, receivedAt: Date.now() });
  await env.ACCESS_KV.put(PENDING_KEY, JSON.stringify(pending), { expirationTtl: 24 * 60 * 60 });
}
__name(queuePremium, "queuePremium");
async function logConfirmation(env, item, res, keyPrefix) {
  const now = /* @__PURE__ */ new Date();
  const record = {
    date: now.toISOString().slice(0, 10),
    decidedAt: now.toISOString(),
    queuedAt: new Date(item.receivedAt).toISOString(),
    targetLine: item.parsed.targetLine,
    homeTeam: item.parsed.homeTeam || null,
    awayTeam: item.parsed.awayTeam || null,
    signalMinute: item.parsed.minute,
    signalProba: item.proba != null ? Math.round(item.proba * 1e3) / 1e3 : null,
    tier: res.tier || "premium",
    reason: res.reason || null,
    live: res.live || null,
    liveProba: res.score ? Math.round(res.score.proba * 1e3) / 1e3 : null,
    goalPoints: res.goal ? res.goal.points : null,
    signalOdds: item.signalOdds || null,
    postOdds: res.postOdds || null
  };
  await env.ACCESS_KV.put(`${keyPrefix}:${now.getTime()}:${item.id}`, JSON.stringify(record), {
    expirationTtl: 180 * 24 * 60 * 60
  });
}
__name(logConfirmation, "logConfirmation");
async function runMinuteJobs(env) {
  const [pending, tracked] = await Promise.all([readPending(env), readTracked(env)]);
  const now = Date.now();
  const due = pending.filter((p) => now - p.receivedAt >= CONFIRM_DELAY_MS);
  if (!due.length && !tracked.length) return;
  const feed = await fetchFeed();
  if (due.length) await processPendingPremium(env, due, feed);
  if (tracked.length) await settleTracked(env, feed);
}
__name(runMinuteJobs, "runMinuteJobs");
async function postUnchecked(env, item, reason) {
  const mq = minQuote(item.proba);
  const label = `\u{1F525} High Confidence (${Math.round(item.proba * 100)}%) \xB7 ohne Live-Pr\xFCfung`;
  await sendTelegramMessage(
    env,
    env.PREMIUM_CHANNEL_ID,
    buildPremiumMessage(item.text, label) + "\n\n" + stakeAdvice(item.parsed.targetLine, mq, UNITS_NORMAL, item.signalOdds)
  );
  await logPremiumForward(env, item.parsed, { proba: item.proba, threshold: null }, "premium:fwd", {
    signalOdds: item.signalOdds || null,
    unchecked: reason
  });
  await logConfirmation(env, item, { reason: `ohne Pr\xFCfung gepostet: ${reason}` }, "premium:ok");
  await trackSignal(env, {
    tier: "premium",
    home: item.parsed.homeTeam,
    away: item.parsed.awayTeam,
    matchId: null,
    line: item.parsed.targetLine,
    minute: item.parsed.minute,
    minQuote: mq,
    units: UNITS_NORMAL,
    odds: item.signalOdds || null
  });
}
__name(postUnchecked, "postUnchecked");
async function processPendingPremium(env, due, feed) {
  const now = Date.now();
  const done = /* @__PURE__ */ new Set();
  for (const item of due) {
    const match = Array.isArray(feed) ? findMatch(feed, item.parsed.homeTeam, item.parsed.awayTeam) : null;
    if (!match) {
      const feedDown = !Array.isArray(feed);
      if (feedDown || now - item.receivedAt >= CONFIRM_GIVE_UP_MS) {
        done.add(item.id);
        const reason = feedDown ? "Live-Feed nicht erreichbar" : "Spiel nicht im Live-Feed gefunden";
        await postUnchecked(env, item, reason);
      }
      continue;
    }
    done.add(item.id);
    const res = confirmLive(item, match);
    res.postOdds = oddsSnapshot(match);
    res.signalOdds = item.signalOdds || null;
    if (res.ok) {
      const label = `\u{1F525} High Confidence (${Math.round(item.proba * 100)}% \u2192 live ${Math.round(res.score.proba * 100)}%)`;
      const expected = Math.min(res.score.proba, res.goal.wr || res.score.proba);
      const mq = minQuote(expected);
      const units = res.goal.points >= 1 ? UNITS_STRONG : UNITS_NORMAL;
      await sendTelegramMessage(
        env,
        env.PREMIUM_CHANNEL_ID,
        buildPremiumMessage(item.text, label) + "\n" + confirmationBlock(res) + "\n\n" + stakeAdvice(item.parsed.targetLine, mq, units, res.postOdds)
      );
      await trackSignal(env, {
        tier: "premium",
        home: item.parsed.homeTeam,
        away: item.parsed.awayTeam,
        matchId: match.id || null,
        line: item.parsed.targetLine,
        minute: res.live.minute,
        minQuote: mq,
        units,
        odds: res.postOdds
      });
      await logPremiumForward(env, item.parsed, res.score, "premium:fwd", {
        signalOdds: item.signalOdds || null,
        postOdds: res.postOdds
      });
      await logConfirmation(env, item, res, "premium:ok");
    } else {
      await logConfirmation(env, item, res, "premium:rej");
    }
  }
  if (done.size) {
    const latest = await readPending(env);
    const left = latest.filter((p) => !done.has(p.id));
    if (left.length) {
      await env.ACCESS_KV.put(PENDING_KEY, JSON.stringify(left), { expirationTtl: 24 * 60 * 60 });
    } else {
      await env.ACCESS_KV.delete(PENDING_KEY);
    }
  }
}
__name(processPendingPremium, "processPendingPremium");
function minQuote(wr) {
  return wr ? Math.ceil(1 / wr * 100) / 100 : null;
}
__name(minQuote, "minQuote");
function fmtQuote(q) {
  return q.toFixed(2).replace(".", ",");
}
__name(fmtQuote, "fmtQuote");
function stakeAdvice(line, mq, units, odds) {
  const unitsText = String(units).replace(".", ",");
  const out = [`\u{1F4B6} Nur setzen ab Quote ${fmtQuote(mq)} (Over ${line}) \xB7 Einsatz: ${unitsText} ${units === 1 ? "Einheit" : "Einheiten"}`];
  if (odds && odds.line === line && odds.over < mq) {
    out.push(`\u23F3 Aktuelle Quote ${fmtQuote(odds.over)} liegt darunter: nur setzen, wenn sie noch steigt.`);
  }
  return out.join("\n");
}
__name(stakeAdvice, "stakeAdvice");
async function readTracked(env) {
  const raw = await env.ACCESS_KV.get(TRACK_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch (e) {
    return [];
  }
}
__name(readTracked, "readTracked");
async function trackSignal(env, entry) {
  const open = await readTracked(env);
  open.push({ id: randomToken().slice(0, 12), postedAt: Date.now(), ...entry });
  await env.ACCESS_KV.put(TRACK_KEY, JSON.stringify(open), { expirationTtl: 2 * 24 * 60 * 60 });
}
__name(trackSignal, "trackSignal");
function findTrackedMatch(feed, t) {
  return t.matchId && feed.find((m) => m.id === t.matchId) || findMatch(feed, t.home, t.away);
}
__name(findTrackedMatch, "findTrackedMatch");
async function settleTracked(env, feed) {
  const open = await readTracked(env);
  if (!open.length || !Array.isArray(feed)) return;
  const now = Date.now();
  let changed = false;
  const keep = [];
  for (const t of open) {
    const m = findTrackedMatch(feed, t);
    let result = null;
    if (m) {
      const goals = (num(m.hg) || 0) + (num(m.ag) || 0);
      const minute = num(m.minute);
      if (goals > t.line) {
        result = "won";
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
        result = "lost";
      }
    } else if (now - t.postedAt >= TRACK_GIVE_UP_MS) {
      result = "void";
    }
    if (result) {
      changed = true;
      await saveResult(env, t, result);
    } else {
      keep.push(t);
    }
  }
  if (!changed) return;
  const latest = await readTracked(env);
  const keepIds = new Set(keep.map((t) => t.id));
  const openIds = new Set(open.map((t) => t.id));
  const merged = keep.concat(latest.filter((t) => !openIds.has(t.id) && !keepIds.has(t.id)));
  if (merged.length) await env.ACCESS_KV.put(TRACK_KEY, JSON.stringify(merged), { expirationTtl: 2 * 24 * 60 * 60 });
  else await env.ACCESS_KV.delete(TRACK_KEY);
}
__name(settleTracked, "settleTracked");
async function saveResult(env, t, result) {
  const now = /* @__PURE__ */ new Date();
  const priced = t.odds && t.odds.line === t.line && t.odds.over ? t.odds.over : null;
  const betPlaced = priced != null && priced >= t.minQuote;
  let profit = null;
  if (betPlaced && result !== "void") profit = result === "won" ? t.units * (priced - 1) : -t.units;
  const record = {
    tier: t.tier,
    home: t.home,
    away: t.away,
    line: t.line,
    minute: t.minute,
    postedAt: new Date(t.postedAt).toISOString(),
    settledAt: now.toISOString(),
    result,
    resultMinute: t.resultMinute != null ? t.resultMinute : null,
    units: t.units,
    minQuote: t.minQuote,
    quote: priced,
    betPlaced,
    profit: profit != null ? Math.round(profit * 100) / 100 : null
  };
  await env.ACCESS_KV.put(`result:${now.getTime()}:${t.id}`, JSON.stringify(record), {
    expirationTtl: 365 * 24 * 60 * 60
  });
}
__name(saveResult, "saveResult");
async function listResults(env, sinceMs) {
  const rows = [];
  let cursor;
  do {
    const list = await env.ACCESS_KV.list({ prefix: "result:", cursor });
    for (const key of list.keys) {
      const ts = Number(key.name.split(":")[1]);
      if (sinceMs && ts < sinceMs) continue;
      const raw = await env.ACCESS_KV.get(key.name);
      if (raw) {
        try {
          rows.push(JSON.parse(raw));
        } catch (e) {
        }
      }
    }
    cursor = list.list_complete ? void 0 : list.cursor;
  } while (cursor);
  rows.sort((a, b) => b.settledAt.localeCompare(a.settledAt));
  return rows;
}
__name(listResults, "listResults");
function summarize(rows) {
  const decided = rows.filter((r) => r.result === "won" || r.result === "lost");
  const tally = /* @__PURE__ */ __name((list) => ({ n: list.length, won: list.filter((r) => r.result === "won").length }), "tally");
  const priced = decided.filter((r) => r.profit != null);
  return {
    all: tally(decided),
    premium: tally(decided.filter((r) => r.tier === "premium")),
    risk: tally(decided.filter((r) => r.tier === "risk")),
    half: tally(decided.filter((r) => r.tier === "half")),
    priced: priced.length,
    profit: Math.round(priced.reduce((a, r) => a + r.profit, 0) * 100) / 100,
    staked: priced.reduce((a, r) => a + r.units, 0)
  };
}
__name(summarize, "summarize");
function pctText(t) {
  return t.n ? `${t.won}/${t.n} = ${(Math.round(t.won / t.n * 1e3) / 10).toString().replace(".", ",")} %` : "\u2013";
}
__name(pctText, "pctText");
function weeklyReportText(sum, fromDate, toDate) {
  const d = /* @__PURE__ */ __name((x) => x.toISOString().slice(8, 10) + "." + x.toISOString().slice(5, 7) + ".", "d");
  const lines = [
    `\u{1F4CA} Wochenbilanz Premium (${d(fromDate)}\u2013${d(toDate)})`,
    "",
    `\u{1F525} High Confidence: ${pctText(sum.premium)}`,
    `\u{1F7E0} Half-Risiko: ${pctText(sum.half)}`,
    `\u26A0\uFE0F Risiko: ${pctText(sum.risk)}`,
    `Gesamt: ${pctText(sum.all)}`
  ];
  if (sum.priced) {
    const sign = sum.profit >= 0 ? "+" : "";
    const roi = sum.staked ? Math.round(sum.profit / sum.staked * 1e3) / 10 : 0;
    lines.push("", `\u{1F4B6} Mit Quote ab Mindestquote gesetzt (${sum.priced} ${sum.priced === 1 ? "Tipp" : "Tipps"}): ${sign}${String(sum.profit).replace(".", ",")} Einheiten (Rendite ${sign}${String(roi).replace(".", ",")} %)`);
  }
  lines.push("", "Automatisch ausgewertet aus dem Live-Spielstand. Keine Gewinngarantie, 18+.");
  return lines.join("\n");
}
__name(weeklyReportText, "weeklyReportText");
async function sendWeeklyReport(env) {
  const to = /* @__PURE__ */ new Date();
  const from = new Date(to.getTime() - 7 * DAY_MS);
  const sum = summarize(await listResults(env, from.getTime()));
  if (!sum.all.n) return;
  await sendTelegramMessage(env, env.PREMIUM_CHANNEL_ID, weeklyReportText(sum, from, to));
}
__name(sendWeeklyReport, "sendWeeklyReport");
async function listLog(env, prefix) {
  const rows = [];
  let cursor;
  do {
    const list = await env.ACCESS_KV.list({ prefix, cursor });
    for (const key of list.keys) {
      const raw = await env.ACCESS_KV.get(key.name);
      if (raw) {
        try {
          rows.push(JSON.parse(raw));
        } catch (e) {
        }
      }
    }
    cursor = list.list_complete ? void 0 : list.cursor;
  } while (cursor);
  rows.sort((a, b) => b.decidedAt.localeCompare(a.decidedAt));
  return rows;
}
__name(listLog, "listLog");
async function premiumExportCsv(env) {
  const kinds = [
    ["premium:fwd:", "forwarded"],
    ["risk:fwd:", "risk"],
    ["half:fwd:", "half"],
    ["premium:ok:", "confirmed"],
    ["premium:rej:", "rejected"],
    ["half:rej:", "half_rejected"]
  ];
  const cols = [
    "kind",
    "time",
    "date",
    "home",
    "away",
    "target_line",
    "signal_minute",
    "signal_proba",
    "live_minute",
    "live_score",
    "live_proba",
    "goal_points",
    "signal_over",
    "signal_under",
    "signal_line",
    "post_over",
    "post_under",
    "post_line",
    "reason"
  ];
  const cell = /* @__PURE__ */ __name((v) => {
    const t = v == null ? "" : String(v);
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  }, "cell");
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
          kind,
          r.forwardedAt || r.decidedAt,
          r.date,
          r.homeTeam,
          r.awayTeam,
          r.targetLine,
          r.signalMinute != null ? r.signalMinute : r.minute,
          r.signalProba != null ? r.signalProba : r.modelProba,
          live.minute,
          live.score,
          r.liveProba,
          r.goalPoints,
          so.over,
          so.under,
          so.line,
          po.over,
          po.under,
          po.line,
          r.reason
        ].map(cell).join(","));
      }
      cursor = list.list_complete ? void 0 : list.cursor;
    } while (cursor);
  }
  return lines.join("\n") + "\n";
}
__name(premiumExportCsv, "premiumExportCsv");
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
__name(resolveAccess, "resolveAccess");
function deniedPage({ reason }) {
  const messages = {
    missing: "Kein Zugangslink erkannt. Bitte nutze den Link, den du erhalten hast.",
    invalid: "Dieser Zugangslink ist ung\xFCltig.",
    expired: "Dein 24-Stunden-Testzugang ist abgelaufen."
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
    Am schnellsten geht's direkt \xFCber Telegram \u2014 oder per Formular, wenn du kein Telegram nutzt.</p>
    <a href="https://t.me/harzpassage_bot" target="_blank" rel="noopener" style="display:block; text-align:center; background:#4caf7a; color:#0d1310; text-decoration:none; font-weight:700; padding:12px 16px; border-radius:6px; margin-bottom:16px;">\u{1F4AC} Direkt \xFCber Telegram schreiben</a>
    <p style="text-align:center; color:#8891a3; font-size:0.85rem; margin:-8px 0 16px;">\u2014 oder \u2014</p>
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
      out.textContent = 'Wird gesendet \u2026';
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
  <\/script>
</body></html>`, 403);
}
__name(deniedPage, "deniedPage");
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
<h1>Zugangsverwaltung \u2014 MoneyBag Analyst</h1>

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
  <h3>Zugang nach Zahlung verl\xE4ngern</h3>
  <label>Token</label>
  <input type="text" id="ext-token" placeholder="Token aus dem Link">
  <label>Tage</label>
  <input type="number" id="ext-days" value="30">
  <button id="ext-btn">Verl\xE4ngern</button>
  <div class="out" id="ext-out"></div>
</section>

<section>
  <h3>Bilanz (automatisch ausgewertet)</h3>
  <p style="font-size:0.8rem;color:#8891a3;margin:0 0 10px;">Jedes gepostete Signal wird im Live-Spielstand verfolgt und als Treffer oder Fehlschlag gewertet. Die Wochenbilanz geht jeden Montag um 10 Uhr (MESZ) automatisch in den Premium-Kanal.</p>
  <button id="test-btn" style="background:#2c3444;color:#e6e9f0;margin-bottom:8px;">Test-Signal an Premium-Kanal senden</button>
  <div class="out" id="test-out" style="margin-bottom:10px;"></div>
  <button id="test-half-btn" style="background:#2c3444;color:#e6e9f0;margin-bottom:8px;">Test Half-Risiko senden</button>
  <div class="out" id="test-half-out" style="margin-bottom:10px;"></div>
  <button id="res7-btn">Letzte 7 Tage</button>
  <button id="res30-btn" style="margin-left:6px;">Letzte 30 Tage</button>
  <div id="res-out" style="margin-top:10px;"></div>
</section>

<section>
  <h3>Premium-Best\xE4tigungen</h3>
  <p style="font-size:0.8rem;color:#8891a3;margin:0 0 10px;">High-Confidence-Signale werden 2 min nach der Karte live gepr\xFCft und nur dann gepostet, wenn sie noch passen. Half-Risiko-Karten (68\u201369') werden sofort gepr\xFCft und stehen ebenfalls hier, mit \u{1F7E0} markiert.</p>
  <button id="confirm-btn">Aktualisieren</button>
  <button id="export-btn" style="margin-left:6px;">Log als CSV exportieren</button>
  <div id="confirm-out" style="margin-top:10px;"></div>
</section>

<section>
  <h3>Backup</h3>
  <p style="font-size:0.8rem;color:#8891a3;margin:0 0 10px;">Sichert alle Zug\xE4nge, Premium-Logs und Warteschlangen. Datei z. B. in Dropbox oder iCloud ablegen. Einspielen \xFCberschreibt gleichnamige Eintr\xE4ge, l\xF6scht aber nichts.</p>
  <button id="backup-btn">Backup herunterladen</button>
  <label for="restore-file" style="margin-top:12px;">Backup einspielen (JSON-Datei)</label>
  <input type="file" id="restore-file" accept="application/json,.json">
  <button id="restore-btn">Einspielen</button>
  <div class="out" id="backup-out"></div>
</section>

<section>
  <h3>Alle Zug\xE4nge</h3>
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
    out.textContent = 'Verl\xE4ngert bis: ' + new Date(res.expiresAt).toLocaleString('de-DE');
  } catch (e) { out.textContent = e.message; }
});

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function pct(v) { return v == null ? '-' : Math.round(v * 100) + '%'; }
function hm(iso) { return iso ? new Date(iso).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-'; }

document.getElementById('confirm-btn').addEventListener('click', async () => {
  const out = document.getElementById('confirm-out');
  out.textContent = 'Lade \u2026';
  try {
    const r = await fetch('/admin/api/confirm-log', { headers: { 'Authorization': 'Bearer ' + pw() } });
    if (!r.ok) throw new Error('Fehler ' + r.status + ' (falsches Passwort?)');
    const data = await r.json();
    const rows = data.confirmed.map(x => Object.assign({ ok: true }, x))
      .concat(data.rejected.map(x => Object.assign({ ok: false }, x)))
      .sort((a, b) => b.decidedAt.localeCompare(a.decidedAt));
    const total = rows.length;
    const okCount = data.confirmed.length;
    let html = '<div style="font-size:0.85rem;margin-bottom:8px;">Wartend: <b>' + data.pending.length + '</b> \xB7 Gepostet: <b>' + okCount + '</b> \xB7 Verworfen: <b>' + (total - okCount) + '</b></div>';
    if (data.pending.length) {
      html += '<div style="font-size:0.8rem;color:#8891a3;margin-bottom:8px;">Wartet: ' + data.pending.map(p => esc((p.parsed.homeTeam || '?') + ' \u2013 ' + (p.parsed.awayTeam || '?'))).join(', ') + '</div>';
    }
    if (!total) { out.innerHTML = html + 'Noch keine Entscheidungen.'; return; }
    html += '<table><tr><th>Zeit</th><th>Spiel</th><th>Ergebnis</th><th>Live</th></tr>';
    rows.slice(0, 100).forEach(x => {
      const q = o => o ? 'O' + esc(o.line) + ' @ ' + Number(o.over).toFixed(2) : '-';
      const live = (x.live && x.live.minute != null ? x.live.minute + "' " + esc(x.live.score) : '-') +
        '<br><small>Signal ' + q(x.signalOdds) + '<br>Post ' + q(x.postOdds) + '</small>';
      const detail = x.ok
        ? '<span style="color:#4caf7a;">\u2705 gepostet</span><br><small>' + (x.tier === 'half' ? '' : 'Modell ' + pct(x.liveProba) + ' \xB7 ') + 'Tor-Score ' + (x.goalPoints > 0 ? '+' : '') + esc(x.goalPoints) + '</small>'
        : '<span style="color:#e0a040;">\u2716 verworfen</span><br><small>' + esc(x.reason) + '</small>';
      html += '<tr><td>' + hm(x.decidedAt) + '</td><td>' + esc(x.homeTeam) + ' \u2013 ' + esc(x.awayTeam) + '<br><small>' + (x.tier === 'half' ? '\u{1F7E0} Half-Risiko \xB7 ' : '') + 'O' + esc(x.targetLine) + ' \xB7 Signal ' + esc(x.signalMinute) + "' \xB7 " + pct(x.signalProba) + '</small></td><td>' + detail + '</td><td>' + live + '</td></tr>';
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
      ' Eintr\xE4ge. Falls kein Download startet: Text kopieren und als ' + name + ' speichern.</div>' +
      '<textarea readonly style="width:100%;height:160px;background:#202634;color:#e6e9f0;border:1px solid #2c3444;font-size:0.7rem;">' + esc(csv) + '</textarea>';
  } catch (e) { out.textContent = e.message; }
});

document.getElementById('backup-btn').addEventListener('click', async () => {
  const out = document.getElementById('backup-out');
  out.textContent = 'Erstelle Backup \u2026';
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
    out.innerHTML = 'Backup mit <b>' + data.count + '</b> Eintr\xE4gen erstellt (' + esc(name) + '). Falls kein Download startet: Text kopieren und als .json speichern.' +
      '<textarea readonly style="width:100%;height:120px;margin-top:6px;background:#202634;color:#e6e9f0;border:1px solid #2c3444;font-size:0.7rem;">' + esc(text) + '</textarea>';
  } catch (e) { out.textContent = e.message; }
});

document.getElementById('restore-btn').addEventListener('click', async () => {
  const out = document.getElementById('backup-out');
  const file = document.getElementById('restore-file').files[0];
  if (!file) { out.textContent = 'Bitte zuerst eine Backup-Datei ausw\xE4hlen.'; return; }
  out.textContent = 'Spiele Backup ein \u2026';
  try {
    const text = await file.text();
    const r = await fetch('/admin/api/restore', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + pw(), 'Content-Type': 'application/json' },
      body: text
    });
    const res = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(res.error || ('Fehler ' + r.status + ' (falsches Passwort?)'));
    out.textContent = res.restored + ' Eintr\xE4ge wiederhergestellt' + (res.expired ? ', ' + res.expired + ' bereits abgelaufene \xFCbersprungen.' : '.');
  } catch (e) { out.textContent = e.message; }
});

async function loadResults(days) {
  const out = document.getElementById('res-out');
  out.textContent = 'Lade \u2026';
  try {
    const r = await fetch('/admin/api/results?days=' + days, { headers: { 'Authorization': 'Bearer ' + pw() } });
    if (!r.ok) throw new Error('Fehler ' + r.status + ' (falsches Passwort?)');
    const d = await r.json();
    const s = d.summary;
    const t = x => x.n ? x.won + '/' + x.n + ' = ' + (Math.round(x.won / x.n * 1000) / 10) + ' %' : '\u2013';
    let html = '<div style="font-size:0.9rem;line-height:1.6;">High Confidence: <b>' + t(s.premium) + '</b><br>Half-Risiko: <b>' + t(s.half || {n:0}) + '</b><br>Risiko: <b>' + t(s.risk) + '</b><br>Gesamt: <b>' + t(s.all) + '</b>';
    if (s.priced) html += '<br>Mit Quote ab Mindestquote (' + s.priced + (s.priced === 1 ? ' Tipp' : ' Tipps') + '): <b>' + (s.profit >= 0 ? '+' : '') + s.profit + ' Einheiten</b>';
    html += '<br><span style="color:#8891a3;">Noch offen: ' + d.open.length + '</span></div>';
    html += '<details style="margin-top:8px;"><summary>Vorschau Wochenbilanz-Post</summary><pre style="white-space:pre-wrap;font-size:0.8rem;background:#202634;padding:8px;border-radius:4px;">' + esc(d.reportPreview) + '</pre></details>';
    if (d.rows.length) {
      html += '<table style="margin-top:8px;"><tr><th>Zeit</th><th>Spiel</th><th>Ergebnis</th><th>Quote</th></tr>';
      d.rows.slice(0, 100).forEach(x => {
        const res = x.result === 'won' ? '<span style="color:#4caf7a;">\u2705 Tor ' + (x.resultMinute != null ? x.resultMinute + "'" : '') + '</span>'
          : x.result === 'lost' ? '<span style="color:#e0a040;">\u2716 kein Tor</span>' : '<span style="color:#8891a3;">\u2013 unklar</span>';
        const q = x.quote != null ? Number(x.quote).toFixed(2) + (x.betPlaced ? '' : ' (unter ' + Number(x.minQuote).toFixed(2) + ')') : '\u2013';
        html += '<tr><td>' + hm(x.settledAt) + '</td><td>' + esc(x.home) + ' \u2013 ' + esc(x.away) + '<br><small>' + (x.tier === 'risk' ? 'Risiko' : x.tier === 'half' ? 'Half-Risiko' : 'Premium') + ' \xB7 O' + esc(x.line) + ' \xB7 ' + esc(x.minute) + "' \xB7 " + esc(x.units) + ' E.</small></td><td>' + res + (x.profit != null ? '<br><small>' + (x.profit >= 0 ? '+' : '') + x.profit + ' E.</small>' : '') + '</td><td>' + q + '</td></tr>';
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
  out.textContent = 'Sende \u2026';
  try {
    const r = await fetch('/admin/api/test-post', { method: 'POST', headers: { 'Authorization': 'Bearer ' + pw() } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || ('Fehler ' + r.status + ' (falsches Passwort?)'));
    out.textContent = (d.sent ? '\u2705 Gesendet. ' : '\u274C Telegram hat nicht angenommen. ') +
      (d.feedOk ? 'Live-Feed erreichbar (' + d.matches + ' Spiele)' + (d.match ? ', Beispiel: ' + d.match : '') + '.' : '\u26A0\uFE0F Live-Feed von Cloudflare NICHT erreichbar.');
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
  out.textContent = 'Sende \u2026';
  try {
    const r = await fetch('/admin/api/test-post?tier=half', { method: 'POST', headers: { 'Authorization': 'Bearer ' + pw() } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || ('Fehler ' + r.status + ' (falsches Passwort?)'));
    out.textContent = (d.sent ? '\u2705 Gesendet. ' : '\u274C Telegram hat nicht angenommen. ') +
      (d.feedOk ? 'Beispiel: ' + (d.match || 'kein laufendes Spiel') + '.' : '\u26A0\uFE0F Live-Feed von Cloudflare NICHT erreichbar.');
  } catch (e) { out.textContent = e.message; }
});

document.getElementById('res7-btn').addEventListener('click', () => loadResults(7));
document.getElementById('res30-btn').addEventListener('click', () => loadResults(30));

document.getElementById('list-btn').addEventListener('click', async () => {
  const out = document.getElementById('list-out');
  out.textContent = 'Lade \u2026';
  try {
    const r = await fetch('/admin/api/list', { headers: { 'Authorization': 'Bearer ' + pw() } });
    if (!r.ok) throw new Error('Fehler ' + r.status);
    const rows = await r.json();
    if (!rows.length) { out.textContent = 'Keine Zug\xE4nge.'; return; }
    let html = '<table><tr><th>Token</th><th>Status</th><th>L\xE4uft ab</th></tr>';
    rows.forEach(row => {
      const expired = row.expiresAt < Date.now();
      html += '<tr><td>' + row.token.slice(0,8) + '\u2026</td><td>' + row.status + (expired ? ' (abgelaufen)' : '') + '</td><td>' + new Date(row.expiresAt).toLocaleString('de-DE') + '</td></tr>';
    });
    html += '</table>';
    out.innerHTML = html;
  } catch (e) { out.textContent = e.message; }
});
<\/script>
</body></html>`);
}
__name(handleAdminPage, "handleAdminPage");
var index_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/admin") {
      return handleAdminPage();
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
        expiresAt: Date.now() + hours * 60 * 60 * 1e3
      };
      await putAccess(env, token, record);
      const link = `${url.origin}/?t=${token}`;
      return jsonResponse({ token, url: link, expiresAt: record.expiresAt });
    }
    if (url.pathname === "/admin/api/extend" && request.method === "POST") {
      if (!isAdminAuthed(request, env)) return jsonResponse({ error: "unauthorized" }, 401);
      const body = await request.json().catch(() => ({}));
      const token = String(body.token || "").trim();
      const days = Number(body.days) > 0 ? Number(body.days) : 30;
      if (!token) return jsonResponse({ error: "token fehlt" }, 400);
      const existing = await getAccess(env, token) || {
        token,
        status: "trial",
        createdAt: Date.now(),
        expiresAt: Date.now()
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
            if (rec && typeof rec.token === "string" && rec.expiresAt) rows.push(rec);
          } catch (e) {
          }
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
            } catch (e) {
            }
          }
        }
        cursor = list.list_complete ? void 0 : list.cursor;
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
            } catch (e) {
            }
          }
        }
        cursor = list.list_complete ? void 0 : list.cursor;
      } while (cursor);
      rows.sort((a, b) => b.forwardedAt.localeCompare(a.forwardedAt));
      return jsonResponse(rows);
    }
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
        cursor = list.list_complete ? void 0 : list.cursor;
      } while (cursor);
      const body = JSON.stringify({ format: "moneybag-kv-backup", version: 1, createdAt: (/* @__PURE__ */ new Date()).toISOString(), count: entries.length, entries });
      return new Response(body, {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="moneybag_backup_${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}.json"`
        }
      });
    }
    if (url.pathname === "/admin/api/restore" && request.method === "POST") {
      if (!isAdminAuthed(request, env)) return jsonResponse({ error: "unauthorized" }, 401);
      const backup = await request.json().catch(() => null);
      if (!backup || backup.format !== "moneybag-kv-backup" || !Array.isArray(backup.entries)) {
        return jsonResponse({ error: "Keine g\xFCltige Backup-Datei." }, 400);
      }
      const nowSec = Math.floor(Date.now() / 1e3);
      let restored = 0;
      let expired = 0;
      for (const e of backup.entries) {
        if (!e || typeof e.key !== "string" || typeof e.value !== "string") continue;
        if (e.expiration && e.expiration <= nowSec + 60) {
          expired++;
          continue;
        }
        await env.ACCESS_KV.put(e.key, e.value, e.expiration ? { expiration: e.expiration } : void 0);
        restored++;
      }
      return jsonResponse({ ok: true, restored, expired });
    }
    if (url.pathname === "/admin/api/premium-export" && request.method === "GET") {
      if (!isAdminAuthed(request, env)) return jsonResponse({ error: "unauthorized" }, 401);
      return new Response(await premiumExportCsv(env), {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="premium_log_${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}.csv"`
        }
      });
    }
    if (url.pathname === "/admin/api/test-post" && request.method === "POST") {
      if (!isAdminAuthed(request, env)) return jsonResponse({ error: "unauthorized" }, 401);
      if (!env.PREMIUM_CHANNEL_ID || !env.TELEGRAM_BOT_TOKEN) return jsonResponse({ error: "Premium-Kanal oder Bot-Token fehlt." }, 500);
      const feed = await fetchFeed();
      const feedOk = Array.isArray(feed);
      let text;
      let matchInfo = null;
      if (url.searchParams.get("tier") === "half") {
        let wouldPass = null;
        if (feedOk) {
          const live = feed.map((m) => ({ m, s: liveSnapshot(m) })).filter((x) => x.s.minute != null && x.s.minute >= 20 && x.s.minute <= 89);
          live.sort((a, b) => Math.abs(a.s.minute - HALF_MIN_MINUTE) - Math.abs(b.s.minute - HALF_MIN_MINUTE));
          const pick = live[0];
          if (pick) {
            const s = pick.s;
            const line = s.goals + 0.5;
            const gs = goalScore(s);
            const odds = oddsSnapshot(pick.m);
            wouldPass = s.minute >= HALF_MIN_MINUTE && s.minute < RISK_MINUTE && gs.points >= HALF_MIN_GOAL_POINTS && s.redCards === 0;
            matchInfo = `${pick.m.h} \u2013 ${pick.m.a} (${s.minute}' ${s.score})`;
            text = [
              "\u{1F9EA} TEST \u2013 kein Tipp, bitte nicht setzen",
              `\u{1F7E0} Half-Risiko-Signal (Minute ${s.minute}' \xB7 Tor-Score ${gs.points})`,
              "",
              `\u{1F3C6} ${pick.m.l || ""}`,
              `\u26BD ${pick.m.h} ${s.score} ${pick.m.a}`,
              `\u{1F3AF} Beispiel-Ziel: Over ${line}`,
              `\u{1F4E1} Radar X: ${s.radar != null ? s.radar : "\u2013"}`,
              odds ? `Quote: ${oddsText(odds)}` : null,
              "",
              stakeAdvice(line, minQuote(HALF_WR), UNITS_HALF, odds),
              "",
              `Echt gepostet wird nur bei Minute 68\u201369 und Tor-Score \u2265 ${HALF_MIN_GOAL_POINTS}. Dieses Spiel: ${wouldPass ? "w\xFCrde passen" : "w\xFCrde nicht passen"}.`
            ].filter((x) => x != null).join("\n");
          } else {
            text = `\u{1F9EA} TEST Half-Risiko \u2013 kein Tipp

Live-Feed erreichbar (${feed.length} Spiele), aber gerade kein laufendes Spiel.`;
          }
        } else {
          text = "\u{1F9EA} TEST Half-Risiko \u2013 kein Tipp\n\n\u26A0\uFE0F Live-Feed von Cloudflare NICHT erreichbar. Half-Risiko-Signale werden in diesem Zustand \xFCbersprungen.";
        }
        const sent2 = await sendTelegramMessage(env, env.PREMIUM_CHANNEL_ID, text);
        return jsonResponse({ sent: !!sent2, feedOk, matches: feedOk ? feed.length : 0, match: matchInfo, wouldPass });
      }
      if (feedOk) {
        const live = feed.map((m) => ({ m, s: liveSnapshot(m) })).filter((x) => x.s.minute != null && x.s.minute >= 20 && x.s.minute <= 85);
        live.sort((a, b) => Math.abs(a.s.minute - 60) - Math.abs(b.s.minute - 60));
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
          matchInfo = `${pick.m.h} \u2013 ${pick.m.a} (${s.minute}' ${s.score})`;
          text = [
            "\u{1F9EA} TEST-SIGNAL \u2013 kein Tipp, bitte nicht setzen",
            "",
            `\u{1F3C6} ${pick.m.l || ""}`,
            `\u26BD ${pick.m.h} ${s.score} ${pick.m.a}`,
            `\u{1F3AF} Beispiel-Ziel: Over ${line}`,
            confirmationBlock(res).replace("\u2705 Live best\xE4tigt nach 2 min", "\u2705 Live-Daten abgerufen"),
            "",
            stakeAdvice(line, mq, units, res.postOdds),
            "",
            `Live-Feed von Cloudflare erreichbar: ja (${feed.length} Spiele)`
          ].join("\n");
        } else {
          text = `\u{1F9EA} TEST \u2013 kein Tipp

Live-Feed von Cloudflare erreichbar: ja (${feed.length} Spiele), aber gerade kein laufendes Spiel zwischen 20' und 85'.`;
        }
      } else {
        text = '\u{1F9EA} TEST \u2013 kein Tipp\n\n\u26A0\uFE0F Live-Feed von Cloudflare NICHT erreichbar. Premium-Signale werden in diesem Zustand "ohne Live-Pr\xFCfung" gepostet.';
      }
      const sent = await sendTelegramMessage(env, env.PREMIUM_CHANNEL_ID, text);
      return jsonResponse({ sent: !!sent, feedOk, matches: feedOk ? feed.length : 0, match: matchInfo });
    }
    if (url.pathname === "/admin/api/results" && request.method === "GET") {
      if (!isAdminAuthed(request, env)) return jsonResponse({ error: "unauthorized" }, 401);
      const days = Number(url.searchParams.get("days")) || 7;
      const rows = await listResults(env, Date.now() - days * DAY_MS);
      const sum = summarize(rows);
      const to = /* @__PURE__ */ new Date();
      return jsonResponse({
        days,
        summary: sum,
        open: await readTracked(env),
        rows,
        reportPreview: weeklyReportText(sum, new Date(to.getTime() - days * DAY_MS), to)
      });
    }
    if (url.pathname === "/admin/api/confirm-log" && request.method === "GET") {
      if (!isAdminAuthed(request, env)) return jsonResponse({ error: "unauthorized" }, 401);
      const [ok, rej, halfOk, halfRej] = await Promise.all([
        listLog(env, "premium:ok:"),
        listLog(env, "premium:rej:"),
        listLog(env, "half:ok:"),
        listLog(env, "half:rej:")
      ]);
      const byTime = /* @__PURE__ */ __name((a, b) => b.decidedAt.localeCompare(a.decidedAt), "byTime");
      const confirmed = ok.concat(halfOk).sort(byTime);
      const rejected = rej.concat(halfRej).sort(byTime);
      return jsonResponse({ pending: await readPending(env), confirmed, rejected });
    }
    if (url.pathname === "/telegram-webhook" && request.method === "POST") {
      const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (!env.TELEGRAM_WEBHOOK_SECRET || secret !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response("unauthorized", { status: 401 });
      }
      const update = await request.json().catch(() => null);
      const channelMsg = update && (update.channel_post || update.edited_channel_post);
      if (channelMsg && looksLikeSignalCard(channelMsg.text)) {
        await env.ACCESS_KV.put(
          LATEST_SIGNAL_KEY,
          JSON.stringify({ text: channelMsg.text, receivedAt: Date.now() })
        );
        if (env.PREMIUM_CHANNEL_ID) {
          const parsed = parseForConfidenceScore(channelMsg.text);
          const score = computeConfidenceScore(parsed);
          if (score && score.passes) {
            await queuePremium(env, channelMsg.text, parsed, score, await signalOddsFor(parsed));
          } else if ([0.5, 1.5, 2.5, 3.5].includes(parsed.targetLine) && parsed.minute != null && parsed.minute >= RISK_MINUTE && (parsed.minute >= RISK_MIN_MINUTE || parsed.radar != null && parsed.radar >= RISK_MIN_RADAR)) {
            const probaNote = score ? ` \xB7 Modell: ${Math.round(score.proba * 100)}%` : "";
            const snap = await signalSnapshotFor(parsed);
            const odds = snap.odds;
            const mq = minQuote(RISK_WR);
            await sendTelegramMessage(
              env,
              env.PREMIUM_CHANNEL_ID,
              buildPremiumMessage(channelMsg.text, `\u26A0\uFE0F Risiko-Signal (Minute ${parsed.minute}'+${probaNote})`) + (odds ? `
Quote: ${oddsText(odds)}` : "") + "\n\n" + stakeAdvice(parsed.targetLine, mq, UNITS_RISK, odds)
            );
            await trackSignal(env, {
              tier: "risk",
              home: parsed.homeTeam,
              away: parsed.awayTeam,
              matchId: snap.matchId,
              line: parsed.targetLine,
              minute: parsed.minute,
              minQuote: mq,
              units: UNITS_RISK,
              odds
            });
            await logPremiumForward(env, parsed, score, "risk:fwd", { signalOdds: odds, postOdds: odds });
          } else if ([0.5, 1.5, 2.5, 3.5].includes(parsed.targetLine) && parsed.minute != null && parsed.minute >= HALF_MIN_MINUTE && parsed.minute < RISK_MINUTE) {
            await maybePostHalfRisk(env, channelMsg.text, parsed, score);
          }
        }
      }
      const msg = update && update.message;
      if (msg && msg.chat && msg.chat.type === "private" && env.TELEGRAM_BOT_TOKEN && env.ADMIN_CHAT_ID) {
        const isAdmin = String(msg.chat.id) === String(env.ADMIN_CHAT_ID);
        if (isAdmin) {
          const replyTo = msg.reply_to_message && msg.reply_to_message.message_id;
          const visitorChatId = replyTo && await env.ACCESS_KV.get(`relay:msgid:${replyTo}`);
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
            `\u{1F4AC} Telegram-Kontakt von ${who} (${handle}):
${msg.text}`
          );
          if (forwarded) {
            await env.ACCESS_KV.put(`relay:msgid:${forwarded.message_id}`, String(msg.chat.id), {
              expirationTtl: 30 * 24 * 60 * 60
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
      return new Response("ok", { status: 200 });
    }
    if (url.pathname === "/api/contact" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const name = String(body.name || "").trim().slice(0, 100);
      const email = String(body.email || "").trim().slice(0, 150);
      const message = String(body.message || "").trim().slice(0, 500);
      if (!name || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return jsonResponse({ error: "Bitte Name und eine g\xFCltige E-Mail-Adresse angeben." }, 400);
      }
      if (!env.TELEGRAM_BOT_TOKEN || !env.ADMIN_CHAT_ID) {
        return jsonResponse({ error: "Kontaktformular ist gerade nicht verf\xFCgbar." }, 503);
      }
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const rateKey = `contact_rl:${ip}`;
      if (await env.ACCESS_KV.get(rateKey)) {
        return jsonResponse({ error: "Bitte kurz warten, bevor du erneut sendest." }, 429);
      }
      await env.ACCESS_KV.put(rateKey, "1", { expirationTtl: 60 });
      const lines = [
        "\u{1F4EC} Neue Kontaktanfrage (MoneyBag Analyst, Formular)",
        `Name: ${name}`,
        looksLikeFakeEmail(email) ? `E-Mail: ${email} \u26A0\uFE0F wirkt wie Fake-/Wegwerf-Adresse` : `E-Mail: ${email}`,
        message ? `Nachricht: ${message}` : null
      ].filter(Boolean);
      const sent = await sendTelegramMessage(env, env.ADMIN_CHAT_ID, lines.join("\n"));
      if (!sent) {
        return jsonResponse({ error: "Senden fehlgeschlagen. Bitte sp\xE4ter erneut versuchen." }, 502);
      }
      return jsonResponse({ ok: true });
    }
    if (url.pathname === "/api/latest-signal" && request.method === "GET") {
      const resolved2 = await resolveAccess(request, env);
      if (!resolved2.ok) return jsonResponse({ error: resolved2.reason }, 403);
      const raw = await env.ACCESS_KV.get(LATEST_SIGNAL_KEY);
      if (!raw) return jsonResponse({ error: "none" }, 404);
      return jsonResponse(JSON.parse(raw));
    }
    const resolved = await resolveAccess(request, env);
    if (!resolved.ok) {
      return deniedPage({ reason: resolved.reason });
    }
    if (resolved.queryToken) {
      const maxAge = Math.floor((resolved.access.expiresAt - Date.now()) / 1e3);
      const headers = new Headers({ Location: url.origin + "/" });
      headers.append(
        "Set-Cookie",
        `${COOKIE_NAME}=${encodeURIComponent(resolved.token)}; Path=/; Max-Age=${maxAge}; SameSite=Lax; Secure; HttpOnly`
      );
      return new Response(null, { status: 302, headers });
    }
    return env.ASSETS.fetch(request);
  },
  // Cron triggers (wrangler.toml [triggers]): every minute live-confirms
  // queued premium signals and settles posted ones; Monday morning posts the
  // weekly result summary.
  async scheduled(event, env, ctx) {
    if (!env.PREMIUM_CHANNEL_ID || !env.TELEGRAM_BOT_TOKEN) return;
    if (event.cron === WEEKLY_CRON) ctx.waitUntil(sendWeeklyReport(env));
    else ctx.waitUntil(runMinuteJobs(env));
  }
};
export {
  index_default as default
};
//# sourceMappingURL=index.js.map