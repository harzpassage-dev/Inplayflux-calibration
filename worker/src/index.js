const COOKIE_NAME = "mb_access";
const DAY_MS = 24 * 60 * 60 * 1000;
const LATEST_SIGNAL_KEY = "telegram:latest_signal";

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
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

function isAdminAuthed(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/);
  return !!m && m[1] === env.ADMIN_PASSWORD;
}

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
  // targetLine -> { mean, std, coef, intercept, threshold } for
  // features [minute, total_sot, radar, goalline_pre] in that order.
  2.5: {
    // Grouped by the signal card's actual target line (not strategy name),
    // so this also covers the "... New" template variant introduced 10-04.
    mean: [57.5489, 5.8099, 320.2728, 2.9927],
    std: [4.447, 2.4613, 79.6106, 0.6112],
    coef: [-0.2769, 0.0693, 0.0257, 0.2491],
    intercept: 1.139,
    threshold: 0.80,
  },
  3.5: {
    mean: [62.0784, 7.0823, 333.6862, 3.0036],
    std: [3.1719, 2.5982, 82.0626, 0.6556],
    coef: [-0.2311, 0.076, 0.0504, 0.1891],
    intercept: 0.8621,
    threshold: 0.75,
  },
  1.5: {
    // Merged across all three "Over 1.5" bot-template variants.
    mean: [63.1654, 6.0279, 377.4233, 3.2012],
    std: [4.0098, 2.3251, 68.9015, 0.5045],
    coef: [-0.2786, -0.1526, 0.2299, 0.2624],
    intercept: 1.0578,
    threshold: 0.80,
  },
  0.5: {
    mean: [61.2337, 3.9322, 330.3406, 3.0892],
    std: [0.5743, 2.4593, 77.9449, 0.5761],
    coef: [-0.0684, 0.1215, 0.1318, 0.4201],
    intercept: 1.0135,
    threshold: 0.80,
  },
};

function parseForConfidenceScore(text) {
  const out = {};
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
  m = text.match(/^(?:📊|📖|⚽|🥅|🏟️|🆚|⚔️)?\s*(.+?)\s+\d+\s*[–-]\s*\d+\s+(.+?)\s*$/mu);
  if (m) {
    out.homeTeam = m[1].replace(/^[^\p{L}\p{N}]+/u, "").trim();
    out.awayTeam = m[2].trim();
  }
  m = text.match(/Strike Rate:\s*(\d+)%/i);
  if (m) out.feedWR = parseInt(m[1], 10);
  return out;
}

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
  return { proba, threshold: model.threshold, passes: proba >= model.threshold };
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
const CONFIRM_GIVE_UP_MS = 8 * 60 * 1000; // feed unreachable / match not found for this long -> drop
const FEED_URL = "https://inplayflux.com/maclarv8/GETAllMatches.php?inplay=inplay&v=";
const RISK_MINUTE = 70;
// The model docks every minute, so re-scoring at the later live minute pushed
// many cards just under the threshold for no change in the game. Backtest
// (reports/2026-10-06-premium-channel.md): a 5 pp tolerance keeps the same
// ~81% hit rate with almost twice the posts.
const CONFIRM_TOLERANCE = 0.05;
// Risk tier: only late cards that historically hold up (reports/2026-10-06-premium-channel.md):
// minute >= 72 or Radar >= 410 -> 64.8% vs 55.9% for the rest.
const RISK_MIN_MINUTE = 72;
const RISK_MIN_RADAR = 410;
const RADAR_MARKET_BONUS = 124.7;

// Mirror of calibration/goal_score.json (generated by scripts/goal_drivers.py).
const GOAL_SCORE = {
  minPremium: -2,
  points: {
    min_58_62: -2, min_63_65: -5, min_66p: -7, line_lo: -2, line_hi: 2, ht_hi: 1,
    def_strong: -2, sot9: 2, recent_goal: -1, over_odds_hi: -1, fav_up1: -1,
  },
  bands: [
    { min: -99, max: -9, wr: 0.547 },
    { min: -8, max: -6, wr: 0.64 },
    { min: -5, max: -3, wr: 0.703 },
    { min: -2, max: 0, wr: 0.753 },
    { min: 1, max: 99, wr: 0.821 },
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

async function fetchFeed() {
  try {
    const resp = await fetch(FEED_URL + Date.now(), {
      headers: {
        "User-Agent": "Mozilla/5.0 (moneybag-access live confirm)",
        Referer: "https://inplayflux.com/live-scanner?page=open&lang=en",
        "X-Requested-With": "XMLHttpRequest",
      },
      signal: AbortSignal.timeout(5000),
    });
    return resp.ok ? await resp.json() : null;
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

async function signalOddsFor(parsed) {
  const feed = await fetchFeed();
  return Array.isArray(feed) ? oddsSnapshot(findMatch(feed, parsed.homeTeam, parsed.awayTeam)) : null;
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
  if (goal.points < GOAL_SCORE.minPremium) {
    return { ok: false, reason: `Tor-Score ${goal.points}`, live: s, score, goal };
  }
  return { ok: true, live: s, score, goal };
}

function confirmationBlock(res) {
  const s = res.live;
  const signed = (n) => (n > 0 ? `+${n}` : String(n));
  const lines = [
    "",
    `✅ Live bestätigt nach 2 min: ${s.minute}' · ${s.score}`,
    `Modell ${Math.round(res.score.proba * 100)}% · Tor-Score ${signed(res.goal.points)} (${Math.round(res.goal.wr * 100)}%)`,
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

async function queuePremium(env, text, parsed, score, signalOdds) {
  const pending = await readPending(env);
  pending.push({ id: randomToken().slice(0, 12), text, parsed, proba: score.proba, signalOdds, receivedAt: Date.now() });
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
    signalProba: Math.round(item.proba * 1000) / 1000,
    reason: res.reason || null,
    live: res.live || null,
    liveProba: res.score ? Math.round(res.score.proba * 1000) / 1000 : null,
    goalPoints: res.goal ? res.goal.points : null,
    signalOdds: item.signalOdds || null,
    postOdds: res.postOdds || null,
  };
  await env.ACCESS_KV.put(`${keyPrefix}:${now.getTime()}:${item.id}`, JSON.stringify(record), {
    expirationTtl: 180 * 24 * 60 * 60,
  });
}

async function processPendingPremium(env) {
  const pending = await readPending(env);
  if (!pending.length) return; // the common case: one KV read per minute, no writes
  const now = Date.now();
  const due = pending.filter((p) => now - p.receivedAt >= CONFIRM_DELAY_MS);
  if (!due.length) return;

  const feed = await fetchFeed();

  const done = new Set();
  for (const item of due) {
    const match = Array.isArray(feed) ? findMatch(feed, item.parsed.homeTeam, item.parsed.awayTeam) : null;
    if (!match) {
      // Retry on the next tick until we give up.
      if (now - item.receivedAt >= CONFIRM_GIVE_UP_MS) {
        done.add(item.id);
        const reason = Array.isArray(feed) ? "Spiel nicht im Live-Feed gefunden" : "Live-Feed nicht erreichbar";
        await logConfirmation(env, item, { reason }, "premium:rej");
      }
      continue;
    }
    done.add(item.id);
    const res = confirmLive(item, match);
    res.postOdds = oddsSnapshot(match);
    res.signalOdds = item.signalOdds || null;
    if (res.ok) {
      const label = `🔥 High Confidence (${Math.round(item.proba * 100)}% → live ${Math.round(res.score.proba * 100)}%)`;
      await sendTelegramMessage(env, env.PREMIUM_CHANNEL_ID, buildPremiumMessage(item.text, label) + "\n" + confirmationBlock(res));
      await logPremiumForward(env, item.parsed, res.score, "premium:fwd", {
        signalOdds: item.signalOdds || null,
        postOdds: res.postOdds,
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
        } catch (e) {}
      }
    }
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);
  rows.sort((a, b) => b.decidedAt.localeCompare(a.decidedAt));
  return rows;
}

// One CSV row per logged decision, for scripts/premium_report.py:
//   forwarded / risk    -> posted to the premium channel (premium:fwd / risk:fwd)
//   confirmed / rejected -> outcome of the 2-minute live check (premium:ok / premium:rej)
async function premiumExportCsv(env) {
  const kinds = [
    ["premium:fwd:", "forwarded"],
    ["risk:fwd:", "risk"],
    ["premium:ok:", "confirmed"],
    ["premium:rej:", "rejected"],
  ];
  const cols = [
    "kind", "time", "date", "home", "away", "target_line", "signal_minute", "signal_proba",
    "live_minute", "live_score", "live_proba", "goal_points",
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
          live.minute, live.score, r.liveProba, r.goalPoints,
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
  <h3>Premium-Bestätigungen</h3>
  <p style="font-size:0.8rem;color:#8891a3;margin:0 0 10px;">High-Confidence-Signale werden 2 min nach der Karte live geprüft und nur dann gepostet, wenn sie noch passen.</p>
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
        ? '<span style="color:#4caf7a;">✅ gepostet</span><br><small>Modell ' + pct(x.liveProba) + ' · Tor-Score ' + (x.goalPoints > 0 ? '+' : '') + esc(x.goalPoints) + '</small>'
        : '<span style="color:#e0a040;">✖ verworfen</span><br><small>' + esc(x.reason) + '</small>';
      html += '<tr><td>' + hm(x.decidedAt) + '</td><td>' + esc(x.homeTeam) + ' – ' + esc(x.awayTeam) + '<br><small>O' + esc(x.targetLine) + ' · Signal ' + esc(x.signalMinute) + "' · " + pct(x.signalProba) + '</small></td><td>' + detail + '</td><td>' + live + '</td></tr>';
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
  async fetch(request, env) {
    const url = new URL(request.url);

    // --- Admin ---
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
        expiresAt: Date.now() + hours * 60 * 60 * 1000,
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

    if (url.pathname === "/admin/api/confirm-log" && request.method === "GET") {
      if (!isAdminAuthed(request, env)) return jsonResponse({ error: "unauthorized" }, 401);
      const [confirmed, rejected] = await Promise.all([listLog(env, "premium:ok:"), listLog(env, "premium:rej:")]);
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
            await queuePremium(env, channelMsg.text, parsed, score, await signalOddsFor(parsed));
          } else if (
            [0.5, 1.5, 2.5, 3.5].includes(parsed.targetLine) &&
            parsed.minute != null &&
            parsed.minute >= RISK_MINUTE &&
            (parsed.minute >= RISK_MIN_MINUTE || (parsed.radar != null && parsed.radar >= RISK_MIN_RADAR))
          ) {
            const probaNote = score ? ` · Modell: ${Math.round(score.proba * 100)}%` : "";
            const odds = await signalOddsFor(parsed);
            await sendTelegramMessage(
              env,
              env.PREMIUM_CHANNEL_ID,
              buildPremiumMessage(channelMsg.text, `⚠️ Risiko-Signal (Minute ${parsed.minute}'+${probaNote})`) +
                (odds ? `\nQuote: ${oddsText(odds)}` : "")
            );
            await logPremiumForward(env, parsed, score, "risk:fwd", { signalOdds: odds, postOdds: odds });
          }
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
    return env.ASSETS.fetch(request);
  },

  // Cron trigger (wrangler.toml [triggers]): live-confirms queued premium signals.
  async scheduled(event, env, ctx) {
    if (!env.PREMIUM_CHANNEL_ID || !env.TELEGRAM_BOT_TOKEN) return;
    ctx.waitUntil(processPendingPremium(env));
  },
};
