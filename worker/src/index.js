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

async function tgApi(env, method, payload) {
  const resp = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  const data = await resp.json().catch(() => null);
  return data && data.ok ? data.result : null;
}

// Bot username for the t.me start link, from getMe, cached in KV for a day.
async function botUsername(env) {
  const cached = await env.ACCESS_KV.get("bot:username");
  if (cached) return cached;
  const me = await tgApi(env, "getMe");
  if (!me || !me.username) return null;
  await env.ACCESS_KV.put("bot:username", me.username, { expirationTtl: 24 * 60 * 60 });
  return me.username;
}

// Automatic 24 h trial (since 31.10., owner's plan item 4): the start page button opens the bot with /start test.
// One trial per Telegram user id (trial:tg:<id>, kept a year); the bot answers at once with a one-person invite link
// to the premium channel (valid 2 h) and a 24 h tool link. trialend:<ms>:<id> marks the removal from the premium
// channel; the minute cron (every 10 min) removes the member (ban + unban = kick, may rejoin later as a customer)
// unless the owner sent "/behalten <id>" to the bot. TRIAL_MAX_PER_DAY guards against abuse.
const TRIAL_HOURS = 24;
const TRIAL_MAX_PER_DAY = 30;
const fmtBerlin = (ms) => new Date(ms).toLocaleString("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
async function startTrial(env, msg, origin) {
  const from = msg.from || {};
  const id = String(from.id || msg.chat.id);
  const handle = from.username ? `@${from.username}` : [from.first_name, from.last_name].filter(Boolean).join(" ") || `ID ${id}`;
  const mail = env.IMPRESSUM_EMAIL || CONTACT_EMAIL;
  if (await env.ACCESS_KV.get(`trial:tg:${id}`)) {
    await sendTelegramMessage(env, msg.chat.id, `Du hattest schon einen 24-Stunden-Test. 🙂\n\nPremium kostet 20 € im Monat, monatlich kündbar. Schreib einfach hier deine Frage oder eine E-Mail an ${mail}.`);
    return;
  }
  const day = new Date().toISOString().slice(0, 10);
  const count = Number(await env.ACCESS_KV.get(`trial:count:${day}`)) || 0;
  if (count >= TRIAL_MAX_PER_DAY) {
    await sendTelegramMessage(env, msg.chat.id, "Gerade gibt es sehr viele Anfragen. Wir melden uns persönlich bei dir – bitte hab etwas Geduld.");
    await sendTelegramMessage(env, env.ADMIN_CHAT_ID, `🎁 Test-Anfrage über dem Tageslimit (${TRIAL_MAX_PER_DAY}) von ${handle} (ID ${id}) – bitte von Hand freischalten.`);
    return;
  }
  const now = Date.now();
  const endsAt = now + TRIAL_HOURS * 60 * 60 * 1000;
  const token = randomToken();
  await putAccess(env, token, { token, status: "trial", createdAt: now, expiresAt: endsAt, telegramId: id, auto: true });
  const invite = await tgApi(env, "createChatInviteLink", {
    chat_id: env.PREMIUM_CHANNEL_ID, name: `Test ${handle}`.slice(0, 32), member_limit: 1, expire_date: Math.floor(now / 1000) + 2 * 60 * 60,
  });
  await env.ACCESS_KV.put(`trial:tg:${id}`, JSON.stringify({ startedAt: now, endsAt, handle }), { expirationTtl: 365 * 24 * 60 * 60 });
  await env.ACCESS_KV.put(`trial:count:${day}`, String(count + 1), { expirationTtl: 2 * 24 * 60 * 60 });
  await env.ACCESS_KV.put(`trialend:${endsAt}:${id}`, JSON.stringify({ id, handle, endsAt }), { expirationTtl: 3 * 24 * 60 * 60 });
  const lines = [
    "🎁 Dein 24-Stunden-Test bei MoneyBag läuft!",
    "",
    invite ? `1️⃣ Premium-Kanal beitreten (Link gilt 2 Stunden, nur für dich):\n${invite.invite_link}` : "1️⃣ Die Einladung in den Premium-Kanal schicken wir dir gleich persönlich.",
    "",
    `2️⃣ Analyse-Tool (24 Stunden):\n${origin}/?t=${token}`,
    "",
    `⏰ Der Test endet am ${fmtBerlin(endsAt)} Uhr automatisch – kein Abo, nichts zu kündigen.`,
    `📋 Alle Ergebnisse: ${RESULTS_PAGE_URL}`,
    "",
    "18+ · Keine Gewinngarantie · Setz nie mehr, als du verlieren kannst. Hilfe: check-dein-spiel.de",
  ];
  await sendTelegramMessage(env, msg.chat.id, lines.join("\n"));
  await sendTelegramMessage(env, env.ADMIN_CHAT_ID,
    `🎁 Automatischer 24h-Test gestartet: ${handle} (ID ${id}), endet ${fmtBerlin(endsAt)} Uhr.` +
    (invite ? "" : "\n⚠️ Einladungslink konnte nicht erstellt werden – Bot braucht im Premium-Kanal das Recht „Nutzer einladen“. Bitte von Hand einladen.") +
    `\nWird daraus ein zahlender Kunde, schick mir: /behalten ${id}`);
}

async function endTrials(env) {
  const now = Date.now();
  const list = await env.ACCESS_KV.list({ prefix: "trialend:" });
  for (const key of list.keys) {
    const at = Number(key.name.split(":")[1]);
    if (!(at <= now)) continue;
    const id = key.name.split(":")[2];
    const ok = await tgApi(env, "banChatMember", { chat_id: env.PREMIUM_CHANNEL_ID, user_id: Number(id), until_date: Math.floor(now / 1000) + 60 });
    await tgApi(env, "unbanChatMember", { chat_id: env.PREMIUM_CHANNEL_ID, user_id: Number(id), only_if_banned: true });
    await env.ACCESS_KV.delete(key.name);
    const mail = env.IMPRESSUM_EMAIL || CONTACT_EMAIL;
    await sendTelegramMessage(env, id, `⏰ Dein 24-Stunden-Test ist vorbei – danke fürs Ausprobieren!\n\nAlle Ergebnisse (auch die Verluste): ${RESULTS_PAGE_URL}\nPremium: 20 € im Monat, monatlich kündbar. Schreib hier einfach „Premium“ oder eine E-Mail an ${mail}.`);
    if (!ok) await sendTelegramMessage(env, env.ADMIN_CHAT_ID, `⚠️ Test von ID ${id} beendet, aber der Bot konnte ihn nicht aus dem Premium-Kanal entfernen (Recht „Mitglieder sperren“ fehlt?). Bitte von Hand entfernen.`);
  }
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
  // scripts/recalibrate.py from all exports up to 2026-10-31 (15,230 decided
  // signals, half-time cards excluded), grouped by target line. Unseen days
  // 26.-31.10. (model fit up to 26.10.): O2.5 83.3% n=102 (raw 80.4%), O3.5
  // 76.8% n=95 (raw 75.2%), O0.5 76.6% n=47 (raw 69.7%), O1.5 81.2% n=69
  // (raw 73.6%; premium stays off, see LINES_OFF - 68.7% the week before).
  2.5: {
    mean: [57.465, 5.8348, 322.6226, 3.0849],
    std: [4.2993, 2.4624, 80.1115, 0.6322],
    coef: [-0.2485, 0.0735, 0.0257, 0.2575],
    intercept: 1.1652,
    threshold: 0.80,
  },
  3.5: {
    mean: [61.8406, 7.0855, 333.474, 3.0539],
    std: [2.9916, 2.585, 82.6623, 0.6587],
    coef: [-0.2162, 0.0826, 0.0256, 0.211],
    intercept: 0.9173,
    threshold: 0.75,
  },
  1.5: {
    mean: [61.796, 5.5427, 352.9794, 3.2206],
    std: [3.3522, 2.4854, 75.9204, 0.4903],
    coef: [-0.3425, -0.0952, 0.1611, 0.2448],
    intercept: 0.9927,
    threshold: 0.80,
  },
  0.5: {
    mean: [61.2933, 4.1412, 331.7254, 3.0804],
    std: [0.5596, 2.5747, 80.0979, 0.5051],
    coef: [-0.0205, 0.0163, 0.0212, 0.2858],
    intercept: 0.9136,
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
  // "⚖️ O/U 2.75 → 1.25 📉   Over 1.73  Under 1.98": the odds belong to the live line. Real cards put a 📉/📈
  // between line and odds; until 31.10. this regex missed them, so almost no tip had a signal quote.
  m = text.match(/O\/U\s*[\d.]+\s*→\s*([\d.]+)[^\d\n]*?Over\s*([\d.]+)\s+Under\s*([\d.]+)/i);
  if (m) out.cardOdds = { line: parseFloat(m[1]), over: parseFloat(m[2]), under: parseFloat(m[3]) };
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
  // InPlayFlux renamed the success criterion "Any goal scored" (26.10.), so accept
  // "Target: Any goal ..." too.
  if (out.targetLine == null && out.goals != null && /Target:\s*(?:Any\s+)?Goals?\b/i.test(text)) {
    out.targetLine = out.goals + 0.5;
  }
  m = text.match(/🏆\s*([^\n\r]+)/u);
  if (m) out.league = m[1].trim();
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
// secret APIFOOTBALL_KEY; Pro plan since 01.11.: 7,500 calls/day; one live call per
// minute while cards wait or tips are open, plus a few fixture lookups). It has minute, score and red cards for nearly all leagues, but no
// shots on target, radar or market line, so it only checks "no goal, no red card,
// not too late". Without the key cards are posted unchecked as before.
// Two ways in: direct (api-sports.io, secret APIFOOTBALL_KEY) or via RapidAPI (secret
// RAPIDAPI_KEY, preferred when set). Direct calls from Cloudflare Workers hit API-Football's
// per-IP limit (shared Cloudflare IPs, 01.11.); RapidAPI limits per key.
// Since 01.11. evening a small own server with a dedicated IP (Caddy reverse proxy,
// infra/af-proxy/) can sit in between: AF_PROXY_URL (https://af.moneybag-signals.com) and
// AF_PROXY_SECRET (checked by the proxy, stripped before forwarding). The API key stays here.
const afOn = (env) => !!(env.RAPIDAPI_KEY || env.APIFOOTBALL_KEY);
function afRequest(env, path) {
  if (env.AF_PROXY_URL && env.AF_PROXY_SECRET && env.APIFOOTBALL_KEY) {
    return [String(env.AF_PROXY_URL).replace(/\/+$/, "") + "/" + path,
      { "x-apisports-key": env.APIFOOTBALL_KEY, "x-proxy-secret": env.AF_PROXY_SECRET }];
  }
  if (env.RAPIDAPI_KEY) {
    return ["https://api-football-v1.p.rapidapi.com/v3/" + path,
      { "x-rapidapi-key": env.RAPIDAPI_KEY, "x-rapidapi-host": "api-football-v1.p.rapidapi.com" }];
  }
  return ["https://v3.football.api-sports.io/" + path, { "x-apisports-key": env.APIFOOTBALL_KEY }];
}

async function fetchApiFootballLive(env) {
  return fetchApiFootball(env, "fixtures?live=all");
}

// One API-Football fixture in our shape. goalMinutes: minutes of the goals in the
// first 90 minutes (+ stoppage time) in order, so the n-th goal's minute is exact.
const AF_FINISHED = new Set(["FT", "AET", "PEN"]);
const AF_VOID = new Set(["PST", "CANC", "ABD", "AWD", "WO"]);
function afFixture(f) {
  const status = (f.fixture && f.fixture.status && f.fixture.status.short) || "";
  const ft = f.score && f.score.fulltime;
  // Over/under counts 90 minutes: after extra time take the full-time score.
  const useFt = (status === "AET" || status === "PEN") && ft && ft.home != null;
  const gh = num(useFt ? ft.home : f.goals && f.goals.home) || 0;
  const ga = num(useFt ? ft.away : f.goals && f.goals.away) || 0;
  const events = Array.isArray(f.events) ? f.events : null;
  const goalMinutes = events
    ? events.filter((e) => e.type === "Goal" && !/missed/i.test(e.detail || "") && e.time && num(e.time.elapsed) != null && num(e.time.elapsed) <= 90)
        .map((e) => num(e.time.elapsed)).sort((x, y) => x - y)
    : null;
  return {
    afId: f.fixture && f.fixture.id,
    h: f.teams && f.teams.home && f.teams.home.name,
    a: f.teams && f.teams.away && f.teams.away.name,
    minute: num(f.fixture && f.fixture.status && f.fixture.status.elapsed),
    status,
    finished: AF_FINISHED.has(status),
    voided: AF_VOID.has(status),
    goals: gh + ga,
    score: `${gh}-${ga}`,
    goalMinutes: goalMinutes && goalMinutes.length === gh + ga ? goalMinutes : null,
    redCards: events ? events.filter((e) => e.type === "Card" && /red/i.test(e.detail || "")).length : null,
    // For the own match archive (afm:*, since 01.11.): league, kickoff, half-time score, compact events.
    lg: f.league ? f.league.name : null,
    c: f.league ? f.league.country : null,
    lid: f.league ? f.league.id : null,
    kick: f.fixture ? f.fixture.date : null,
    ht: f.score && f.score.halftime && f.score.halftime.home != null ? `${f.score.halftime.home}-${f.score.halftime.away}` : null,
    ev: events ? afEvents(events, f.teams && f.teams.home && f.teams.home.id) : null,
  };
}

// Events as a short string: type letter + minute (+stoppage) + side, e.g. "G23h,P45+2a,R60h,S70a".
// G goal, P penalty goal, O own goal (side = team credited by API-Football), M missed penalty,
// R red card, S substitution. Yellow cards and VAR notes are left out (size).
function afEvents(events, homeId) {
  const out = [];
  for (const e of events) {
    const d = String(e.detail || "");
    let k = null;
    if (e.type === "Goal") k = /missed/i.test(d) ? "M" : /penalty/i.test(d) ? "P" : /own/i.test(d) ? "O" : "G";
    else if (e.type === "Card" && /red/i.test(d)) k = "R";
    else if (e.type === "subst") k = "S";
    if (!k || !e.time) continue;
    const m = num(e.time.elapsed);
    if (m == null) continue;
    const x = num(e.time.extra);
    const side = e.team && homeId != null && e.team.id === homeId ? "h" : "a";
    out.push(`${k}${m}${x ? "+" + x : ""}${side}`);
  }
  return out.join(",");
}

// Live over/under odds of one fixture from odds/live: { "2.5": { o, u }, "3": {...} } (lines as numbers
// in string form, suspended prices left out). Bet names differ, so every full-match goal total counts.
const AF_OU_BET = /over\/?under|total goals|goals over|asian total|match goals|goal line/i;
const AF_OU_SKIP = /1st|2nd|first|second|half|home|away|team|corner|card|booking|exact/i;
function afOddsLines(entry) {
  const lines = {};
  for (const bet of (entry && entry.odds) || []) {
    const name = String(bet.name || "");
    if (!AF_OU_BET.test(name) || AF_OU_SKIP.test(name)) continue;
    for (const v of bet.values || []) {
      if (v.suspended) continue;
      const val = String(v.value || "");
      const side = /^over/i.test(val) ? "o" : /^under/i.test(val) ? "u" : null;
      const h = num(v.handicap != null && v.handicap !== "" ? v.handicap : (val.match(/[\d.]+/) || [])[0]);
      const odd = num(v.odd);
      if (!side || h == null || odd == null || odd <= 1) continue;
      const key = String(h);
      lines[key] = lines[key] || {};
      if (lines[key][side] == null) lines[key][side] = odd;
    }
  }
  return lines;
}

// After a per-minute rate-limit answer no further calls for 60 s (per isolate),
// so a busy minute does not keep hitting the limit.
let afPauseUntil = 0;
async function fetchApiFootball(env, path, map = afFixture) {
  if (!afOn(env) || Date.now() < afPauseUntil) return null;
  try {
    const [url, headers] = afRequest(env, path);
    const resp = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(10000),
    });
    if (resp.status === 429) afPauseUntil = Date.now() + 60 * 1000;
    if (!resp.ok) return null;
    const data = await resp.json();
    const errors = data && data.errors;
    if (errors && !Array.isArray(errors) && errors.rateLimit) afPauseUntil = Date.now() + 60 * 1000;
    if (!data || !Array.isArray(data.response) || (errors && Object.keys(errors).length)) return null;
    return map ? data.response.map(map) : data.response;
  } catch (e) {
    return null;
  }
}

// Team names differ between InPlayFlux and API-Football ("Drøbak/Frogn" vs
// "Drobak-Frogn", "FC Alpha" vs "Alpha"): exact or contained names first, then a
// shared distinctive word for both teams.
const TEAM_STOP = new Set(["fc", "sc", "fk", "sk", "if", "cf", "ac", "as", "cd", "ud", "sd", "sv", "tsv", "vfb", "vfl", "club",
  "united", "city", "town", "real", "sporting", "athletic", "de", "la", "el", "the", "and", "women", "ii", "u19", "u20", "u21", "u23",
  "reserves", "team", "fotball", "football", "futbol", "calcio", "spor", "ks", "bk", "ik", "il", "ca", "afc", "cfc"]);
function teamWords(name) {
  return String(name || "").toLowerCase().replace(/ø/g, "o").replace(/æ/g, "ae").replace(/ß/g, "ss").replace(/ł/g, "l")
    .normalize("NFKD").replace(/\p{M}/gu, "").split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !TEAM_STOP.has(w));
}
function sameTeam(x, y) {
  const nx = normTeam(x), ny = normTeam(y);
  if (nx && ny && (nx === ny || nx.includes(ny) || ny.includes(nx))) return true;
  // Shared distinctive word; a 4+ letter word may also be the start of the other ("Sheff" / "Sheffield").
  const wy = teamWords(y);
  return teamWords(x).some((w) => wy.some((v) => v === w || (Math.min(w.length, v.length) >= 4 && (v.startsWith(w) || w.startsWith(v)))));
}
function findApiMatch(list, home, away) {
  if (!Array.isArray(list)) return null;
  return findMatch(list, home, away) || list.find((m) => sameTeam(m.h, home) && sameTeam(m.a, away)) || null;
}

// Admin "API-Football prüfen" (since 01.11., paid plan): key set, plan, calls used today,
// live matches right now. Costs 2 calls.
async function apiFootballStatus(env) {
  if (!afOn(env)) return { key: false };
  const call = async (path) => {
    const [url, headers] = afRequest(env, path);
    const resp = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(8000),
    });
    const data = await resp.json().catch(() => null);
    const errors = data && data.errors && !Array.isArray(data.errors) && Object.keys(data.errors).length ? data.errors : null;
    const h = (n) => resp.headers.get(n);
    return { http: resp.status, data, errors, perMin: h("x-ratelimit-limit") || h("x-ratelimit-requests-limit"),
      perMinLeft: h("x-ratelimit-remaining") || h("x-ratelimit-requests-remaining"),
      dayLeft: h("x-ratelimit-requests-remaining") };
  };
  try {
    const st = await call("status");
    const r = st.data && st.data.response;
    const out = {
      key: true, via: env.AF_PROXY_URL && env.AF_PROXY_SECRET && env.APIFOOTBALL_KEY ? "eigener Server" : env.RAPIDAPI_KEY ? "RapidAPI" : "direkt", ok: st.http === 200 && !st.errors && !!r && !Array.isArray(r),
      errors: st.errors, http: st.http, perMin: st.perMin, perMinLeft: st.perMinLeft, pausedByBot: Date.now() < afPauseUntil,
      plan: r && r.subscription ? r.subscription.plan : null,
      active: r && r.subscription ? r.subscription.active : null,
      end: r && r.subscription ? r.subscription.end : null,
      used: r && r.requests ? r.requests.current : null,
      limit: r && r.requests ? r.requests.limit_day : null,
    };
    if (out.ok) {
      const live = await call("fixtures?live=all");
      out.live = live.data && Array.isArray(live.data.response) && !live.errors ? live.data.response.length : null;
      if (live.perMin) out.perMin = live.perMin;
      if (live.perMinLeft) out.perMinLeft = live.perMinLeft;
      if (live.errors) out.errors = live.errors;
    }
    return out;
  } catch (e) {
    return { key: true, ok: false, errors: { fetch: String(e && e.message || e) } };
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
// High Confidence O0.5 (0:0) at a pre-match line >= 4: 93.5% (n=107, halves
// 93/94) in all exports up to 21.10. -> double stake (owner's call 22.10.).
const O05_STRONG_LINE = 4;
const strongO05 = (parsed) => parsed.targetLine === 0.5 && parsed.goallinePre != null && parsed.goallinePre >= O05_STRONG_LINE;
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
// Since 2026-10-29: men's first teams only. Women / youth / reserve games hit 71 % (125 unique matches,
// halves 70/72) vs men 78 % (476, halves 79/77) under the same rule (05.09.–28.10.).
const nonMenMatch = (p) => /U-?\d\d\b|Youth|Junior|Primavera|Reserve|Women|Feminin|Frauen|Damen/i.test(p.league || "") ||
  /U-?\d\d\b|Reserve|\(W\)|Women/i.test(`${p.homeTeam || ""} ${p.awayTeam || ""}`);
const o15TestRule = (parsed) => O15_TEST_ENABLED && parsed.targetLine === 1.5 &&
  parsed.minute != null && parsed.minute <= O15_MAX_MINUTE &&
  parsed.goallinePre != null && parsed.goallinePre >= O15_MIN_LINE_PRE && !nonMenMatch(parsed);
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
const DAILY_CRON = "0 7 * * *";        // every day 07:00 UTC: private morning report to the owner
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
    { min: -8, max: -6, wr: 0.631 },
    { min: -5, max: -3, wr: 0.702 },
    { min: -2, max: 0, wr: 0.747 },
    { min: 1, max: 99, wr: 0.812 },
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
      (odds && !odds.live ? `\nQuote: ${oddsText(odds)}` : "") + "\n\n" +
      stakeAdvice(parsed.targetLine, mq, UNITS_HALF, odds));
  await trackSignal(env, {
    ...post,
    tier: "half", home: parsed.homeTeam, away: parsed.awayTeam, matchId: snap.matchId,
    line: parsed.targetLine, minute: parsed.minute, minQuote: mq, units: UNITS_HALF, odds, signalQuote: cardQuote(parsed),
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

// Over quote for the tip's own line at signal time, from the card's live line
// and odds (no input needed). Same line: the card's quote. Other line: Poisson
// lambda from the card's line, fair probability for the target line, then the
// card's bookmaker margin applied - an estimate, flagged with exact: false.
function cardQuote(parsed) {
  const o = parsed && parsed.cardOdds;
  if (!o || !o.over || !o.under || o.line == null || parsed.goals == null || parsed.targetLine == null) return null;
  const book = 1 / o.over + 1 / o.under;
  const pFair = 1 / o.over / book;
  const r3 = (x) => Math.round(x * 1000) / 1000;
  if (o.line === parsed.targetLine) return { over: o.over, line: o.line, exact: true, p: r3(pFair), book: r3(book) };
  const rest = o.line - parsed.goals;
  if (rest <= 0) return null;
  let lo = 0;
  let hi = 20;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (overLineProb(rest, mid) < pFair) lo = mid;
    else hi = mid;
  }
  const p = poissonTail(Math.floor(parsed.targetLine - parsed.goals) + 1, (lo + hi) / 2);
  if (!(p > 0 && p < 1)) return null;
  return { over: Math.max(1.01, Math.round((1 / (p * book)) * 100) / 100), line: parsed.targetLine, exact: false, p: r3(p), book: r3(book) };
}

// The owner's real entry: wait until the over quote reaches WAIT_QUOTE, then
// bet. Estimated from the signal quote: the rate of the one goal still needed
// falls linearly with the time left (to ~95'), so the quote rises; the entry
// minute is when it reaches WAIT_QUOTE. Goal before it -> no bet, goal after ->
// win at WAIT_QUOTE (or the signal quote if that was already higher), no goal ->
// loss. Needs the exact goal minute (goalExact), otherwise unknown.
const WAIT_QUOTE = 1.4;
function waitEntryMinute(t) {
  const q = t.signalQuote;
  if (!q || !q.p || !q.book || t.minute == null || t.under) return null;
  const target = 1 / (WAIT_QUOTE * q.book);
  if (!(target > 0 && target < 1)) return null;
  const lam0 = -Math.log(1 - Math.min(q.p, 0.999));
  const lamStar = -Math.log(1 - target);
  const left = Math.max(5, 95 - t.minute);
  return Math.round(t.minute + (lamStar >= lam0 ? 0 : left * (1 - lamStar / lam0)));
}

function waitOutcome(t, result) {
  const entry = waitEntryMinute(t);
  if (entry == null || !t.units || (result !== "won" && result !== "lost")) return null;
  const quote = Math.max(WAIT_QUOTE, entry === Math.round(t.minute) ? t.signalQuote.over : WAIT_QUOTE);
  if (result === "lost") return { entry, bet: true, profit: -t.units };
  if (!t.goalExact || t.resultMinute == null) return { entry, bet: null, profit: null };
  if (t.resultMinute < entry) return { entry, bet: false, profit: 0 };
  return { entry, bet: true, profit: Math.round(t.units * (quote - 1) * 100) / 100 };
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

// Queued cards: one KV key per card ("pending:<receivedAt>:<id>", since 22.10.).
// The old single list (PENDING_KEY) was read-modify-write, so two webhook runs
// at the same moment could drop a card; a per-card key is a single put. The
// old key is still read until it has emptied. Each item carries its key.
const PENDING_PREFIX = "pending:";
async function readPending(env) {
  const items = [];
  const raw = await env.ACCESS_KV.get(PENDING_KEY);
  if (raw) {
    try {
      for (const p of JSON.parse(raw)) items.push({ ...p, legacy: true });
    } catch (e) {}
  }
  let cursor;
  const keys = [];
  do {
    const list = await env.ACCESS_KV.list({ prefix: PENDING_PREFIX, cursor });
    keys.push(...list.keys.map((k) => k.name));
    cursor = list.list_complete ? null : list.cursor;
  } while (cursor);
  const vals = await Promise.all(keys.map((k) => env.ACCESS_KV.get(k)));
  vals.forEach((v, i) => {
    if (!v) return; // deleted meanwhile (list is eventually consistent)
    try {
      items.push({ ...JSON.parse(v), key: keys[i] });
    } catch (e) {}
  });
  return items.sort((a, b) => a.receivedAt - b.receivedAt);
}

function premiumItem(text, parsed, score, signalOdds) {
  return { id: randomToken().slice(0, 12), text, parsed, proba: score ? score.proba : null, signalOdds, receivedAt: Date.now() };
}

// Same tip = same tier, match and line (normalised team names).
function tipKey(tier, home, away, line) {
  return `${tier}|${normTeam(home)}|${normTeam(away)}|${line}`;
}

async function queuePremium(env, text, parsed, score, signalOdds, fast = false, tier = "premium") {
  const item = { ...premiumItem(text, parsed, score, signalOdds), fast, tier };
  await env.ACCESS_KV.put(`${PENDING_PREFIX}${item.receivedAt}:${item.id}`, JSON.stringify(item), { expirationTtl: 24 * 60 * 60 });
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
  const collect = afOn(env); // own match archive from API-Football runs every minute (since 01.11.)
  if (!due.length && !tracked.length && !u35Open && !collect) return; // without API-Football: KV reads only, no fetch, no writes
  // A slow feed can make one minute's run overlap the next. Both would then
  // post the same queued card and settle the same tip twice (seen 14.10.:
  // Aston Villa U19 twice in premium, results and the free channel). Only one
  // run at a time does the work; the lock expires on its own if a run dies.
  const lock = await env.ACCESS_KV.get(RUN_LOCK_KEY);
  if (lock && now - Number(lock) < RUN_LOCK_MS) return;
  await env.ACCESS_KV.put(RUN_LOCK_KEY, String(now), { expirationTtl: 120 });
  try {
    const feed = due.length || tracked.length || u35Open ? await fetchFeed() : null;
    // One API-Football source per run: the live list is fetched once and shared.
    const src = afOn(env) ? afSource(env) : null;
    if (due.length) await processPendingPremium(env, due, feed, src);
    if (tracked.length) await settleTracked(env, feed, src);
    if (u35Open) await settleU35(env, feed, u35Keys.map((k, i) => [k, u35Lists[i]]));
    if (src) {
      try {
        await collectMatches(env, src);
      } catch (e) {}
    }
  } finally {
    await env.ACCESS_KV.delete(RUN_LOCK_KEY);
  }
}

const RUN_LOCK_KEY = "lock:minute";
const RUN_LOCK_MS = 110 * 1000;

async function postUnchecked(env, item, reason, label, afId = null) {
  const mq = minQuote(item.proba);
  const units = strongO05(item.parsed) ? UNITS_STRONG : UNITS_NORMAL;
  // No "ohne Live-Prüfung" suffix since 17.10.: without a live source it was on every post (owner's call).
  label = label || `🔥 High Confidence (${Math.round(item.proba * 100)}%)`;
  const post = await postPremium(env, buildPremiumMessage(item.text, label) + "\n\n" +
      stakeAdvice(item.parsed.targetLine, mq, units, liveOdds(item, item.signalOdds)));
  await logPremiumForward(env, item.parsed, { proba: item.proba, threshold: null }, "premium:fwd", {
    signalOdds: item.signalOdds || null,
    unchecked: reason,
  });
  await logConfirmation(env, item, { reason: `ohne Prüfung gepostet: ${reason}` }, "premium:ok");
  await trackSignal(env, {
    ...post,
    tier: "premium", home: item.parsed.homeTeam, away: item.parsed.awayTeam, matchId: null,
    afId: afId || (item.liveQuote && item.liveQuote.afId) || undefined,
    line: item.parsed.targetLine, minute: item.parsed.minute, minQuote: mq, units, odds: liveOdds(item, item.signalOdds || null),
    signalQuote: cardQuote(item.parsed),
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
  }
  odds = liveOdds(item, odds);
  if (match) {
    const reason = live.goals > p.targetLine - 0.5 ? `Tor schon gefallen (${live.score})` : live.redCards > 0 ? "Rote Karte" : null;
    if (reason) return logConfirmation(env, item, { tier: "o15", reason, live }, "o15:rej");
  }
  const mq = minQuote(O15_WR);
  const label = `🧪 Over 1.5 Test (Minute ${p.minute}' · Vor-Spiel-Linie ${String(p.goallinePre).replace(".", ",")}${match ? " · live: kein Tor, keine Rote Karte" : ""})`;
  const post = await postPremium(env, buildPremiumMessage(item.text, label) +
      (odds && !odds.live ? `\nQuote: ${oddsText(odds)}` : "") + "\n\n" +
      "Testbetrieb seit 21.10.: Rückblick 76 % (522 Spiele), halber Einsatz.\n" +
      stakeAdvice(p.targetLine, mq, UNITS_HALF, odds));
  await trackSignal(env, {
    ...post,
    tier: "o15", home: p.homeTeam, away: p.awayTeam, matchId: match ? match.id || null : null,
    afId: (item.liveQuote && item.liveQuote.afId) || undefined,
    line: p.targetLine, minute: live && live.minute != null ? live.minute : p.minute, minQuote: mq, units: UNITS_HALF, odds,
    signalQuote: cardQuote(p),
  });
  await logPremiumForward(env, p, item.proba != null ? { proba: item.proba, threshold: null } : null, "o15:fwd", { signalOdds: item.signalOdds || null, postOdds: odds });
  await logConfirmation(env, item, { tier: "o15", live, postOdds: odds }, "o15:ok");
}

async function processPendingPremium(env, due, feed, src = null) {
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
    // Real live quote of the tip's own line from API-Football for the post (owner's wish 01.11.).
    if (src && !item.liveQuote) {
      try {
        item.liveQuote = await apiLiveQuote(src, item.parsed);
      } catch (e) {}
    }
    if (tier === "o15") {
      done.add(item.id);
      await postO15Test(env, item, Array.isArray(feed) ? findMatch(feed, item.parsed.homeTeam, item.parsed.awayTeam) : null);
      continue;
    }
    const match = Array.isArray(feed) ? findMatch(feed, item.parsed.homeTeam, item.parsed.awayTeam) : null;
    if (!match && afOn(env) && (!Array.isArray(feed) || isGuestFeed(feed))) {
      if (apiLive === undefined) apiLive = await (src || afSource(env)).live();
      const m = apiLive ? findApiMatch(apiLive, item.parsed.homeTeam, item.parsed.awayTeam) : null;
      const res = m ? confirmBasic(item, m) : null;
      if (res && res.ok) {
        done.add(item.id);
        await postUnchecked(env, item, "nur Tor/Rote Karte geprüft (API-Football)",
          `🔥 High Confidence (${Math.round(item.proba * 100)}%) · live geprüft: kein Tor, keine Rote Karte`, m.afId);
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
      const units = res.goal.points >= 1 || strongO05(item.parsed) ? UNITS_STRONG : UNITS_NORMAL;
      const post = await postPremium(env, buildPremiumMessage(item.text, label) + "\n" + confirmationBlock(res) + "\n\n" +
          stakeAdvice(item.parsed.targetLine, mq, units, liveOdds(item, res.postOdds)));
      await trackSignal(env, {
        ...post,
        tier: "premium", home: item.parsed.homeTeam, away: item.parsed.awayTeam, matchId: match.id || null,
        afId: (item.liveQuote && item.liveQuote.afId) || undefined,
        line: item.parsed.targetLine, minute: res.live.minute, minQuote: mq, units, odds: liveOdds(item, res.postOdds),
        signalQuote: cardQuote(item.parsed),
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
    await Promise.all(due.filter((p) => done.has(p.id) && p.key).map((p) => env.ACCESS_KV.delete(p.key)));
    if (due.some((p) => p.legacy && done.has(p.id))) {
      // Old single list: re-read so nothing queued there meanwhile is lost.
      const raw = await env.ACCESS_KV.get(PENDING_KEY);
      let left = [];
      try {
        left = (raw ? JSON.parse(raw) : []).filter((p) => !done.has(p.id));
      } catch (e) {}
      if (left.length) await env.ACCESS_KV.put(PENDING_KEY, JSON.stringify(left), { expirationTtl: 24 * 60 * 60 });
      else await env.ACCESS_KV.delete(PENDING_KEY);
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
// Live over price of the tip's own line at posting time (API-Football odds/live), or null.
async function apiLiveQuote(src, parsed) {
  const live = await src.live();
  const hit = findApiMatch(live, parsed.homeTeam, parsed.awayTeam);
  if (!hit) return null;
  const odds = await src.odds();
  const own = odds && odds.get(hit.afId) && odds.get(hit.afId)[String(parsed.targetLine)];
  if (!own || own.o == null) return { afId: hit.afId };
  return { line: parsed.targetLine, over: own.o, under: own.u ?? null, minute: hit.minute, live: true, afId: hit.afId, at: new Date().toISOString() };
}
const liveOdds = (item, fallback) => (item.liveQuote && item.liveQuote.live ? item.liveQuote : fallback);

function stakeAdvice(line, mq, units, odds) {
  const unitsText = String(units).replace(".", ",");
  const out = [`💶 Nur setzen ab Quote ${fmtQuote(mq)} (Over ${line}) · Einsatz: ${unitsText} ${units === 1 ? "Einheit" : "Einheiten"}`];
  if (odds && odds.live && odds.line === line) {
    out.push(odds.over >= mq
      ? `📈 Live-Quote jetzt: ${fmtQuote(odds.over)} (Over ${line}) – über der Mindestquote ✅`
      : `📈 Live-Quote jetzt: ${fmtQuote(odds.over)} (Over ${line}) – noch unter der Mindestquote ⏳ nur setzen, wenn sie steigt.`);
  } else if (odds && odds.line === line && odds.over < mq) {
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

// Since 01.11. (paid API-Football): a tip missing from the InPlayFlux guest feed is
// looked up there – in the live list (by fixture id once known, else by team
// names), then by fixture id once it left the live list, and if never found, in the
// day's fixture list (once per run). Finished matches settle with the exact goal
// minute and the final score; postponed/abandoned ones are void.
const AF_ID_LOOKUPS_PER_RUN = 8;
const AF_DAY_RETRY_MS = 15 * 60 * 1000;
const AF_DAY_AFTER_MS = 60 * 60 * 1000; // a card at ~60' is decided about an hour later

function afSource(env) {
  let live;
  const days = new Map();
  let idLeft = AF_ID_LOOKUPS_PER_RUN;
  let oddsMap;
  return {
    async live() {
      if (live === undefined) live = await fetchApiFootballLive(env);
      return live;
    },
    async byId(id) {
      if (idLeft-- <= 0) return null;
      const r = await fetchApiFootball(env, "fixtures?id=" + encodeURIComponent(id));
      return r && r[0] ? r[0] : null;
    },
    async day(date) {
      if (!days.has(date)) days.set(date, await fetchApiFootball(env, "fixtures?date=" + date));
      return days.get(date);
    },
    // All live odds in one call, as Map fixture id -> over/under lines (fetched once per run).
    async odds() {
      if (oddsMap === undefined) {
        const raw = await fetchApiFootball(env, "odds/live", null);
        oddsMap = raw ? new Map(raw.map((e) => [e.fixture && e.fixture.id, afOddsLines(e)])) : null;
      }
      return oddsMap;
    },
    async ids(list) {
      return fetchApiFootball(env, "fixtures?ids=" + list.join("-"));
    },
  };
}

// Own match archive (point 2 of the API plan, 01.11.): every match in API-Football's live list is
// remembered by id (af:prev); once it leaves the list it is fetched by id (20 per call, max 60 per
// run) and its final record goes into the day bucket afm:<kickoff date> (180 days). Not yet finished
// (interrupted, or briefly missing) → retried up to 10 runs. Costs ~1 call per 20 matches.
const AF_PREV_KEY = "af:prev";
const AF_IDS_PER_RUN = 60;
async function collectMatches(env, src) {
  const live = await src.live();
  if (!Array.isArray(live)) return;
  let prev = { ids: [], pend: [] };
  try {
    prev = JSON.parse((await env.ACCESS_KV.get(AF_PREV_KEY)) || "") || prev;
  } catch (e) {}
  const cur = live.map((f) => f.afId).filter((id) => id != null);
  const curSet = new Set(cur);
  const pend = new Map((prev.pend || []).filter(([id]) => !curSet.has(id)));
  for (const id of prev.ids || []) if (!curSet.has(id) && !pend.has(id)) pend.set(id, 0);
  const todo = [...pend.keys()].slice(0, AF_IDS_PER_RUN);
  const done = [];
  for (let i = 0; i < todo.length; i += 20) {
    const got = await src.ids(todo.slice(i, i + 20));
    if (!got) break;
    for (const f of got) {
      if (f.finished || f.voided) {
        done.push(f);
        pend.delete(f.afId);
      }
    }
    for (const id of todo.slice(i, i + 20)) if (pend.has(id)) pend.set(id, pend.get(id) + 1);
  }
  for (const [id, n] of pend) if (n >= 10) pend.delete(id);
  if (done.length) {
    const byDay = new Map();
    for (const f of done) {
      const day = String(f.kick || new Date().toISOString()).slice(0, 10);
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push({ id: f.afId, k: f.kick, c: f.c, lg: f.lg, lid: f.lid, h: f.h, a: f.a, st: f.status, ht: f.ht,
        ft: f.score, ev: f.ev });
    }
    for (const [day, recs] of byDay) {
      const key = "afm:" + day;
      let list = [];
      try {
        list = JSON.parse((await env.ACCESS_KV.get(key)) || "[]");
      } catch (e) {}
      const have = new Set(list.map((r) => r.id));
      const add = recs.filter((r) => !have.has(r.id));
      if (add.length) await env.ACCESS_KV.put(key, JSON.stringify(list.concat(add)), { expirationTtl: 180 * 24 * 60 * 60 });
    }
  }
  const next = { ids: cur, pend: [...pend.entries()] };
  const same = JSON.stringify(next) === JSON.stringify({ ids: prev.ids || [], pend: prev.pend || [] });
  if (!same) await env.ACCESS_KV.put(AF_PREV_KEY, JSON.stringify(next), { expirationTtl: 2 * 24 * 60 * 60 });
}

async function listMatches(env, days) {
  const since = new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
  const rows = [];
  let cursor;
  do {
    const list = await env.ACCESS_KV.list({ prefix: "afm:", cursor });
    for (const k of list.keys) {
      if (k.name.slice(4) < since) continue;
      try {
        rows.push(...JSON.parse((await env.ACCESS_KV.get(k.name)) || "[]"));
      } catch (e) {}
    }
    cursor = list.list_complete ? null : list.cursor;
  } while (cursor);
  return rows;
}

const MATCH_CSV_COLS = ["id", "k", "c", "lg", "lid", "h", "a", "st", "ht", "ft", "ev"];
function matchesCsv(rows) {
  const cell = (v) => (v == null ? "" : /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v));
  const head = ["fixtureId", "kickoff", "country", "league", "leagueId", "home", "away", "status", "halftime", "fulltime", "events"];
  return [head.join(",")].concat(rows.map((r) => MATCH_CSV_COLS.map((c) => cell(r[c])).join(","))).join("\n") + "\n";
}

// Admin "Quoten-Abdeckung prüfen": how many live matches have live over/under odds right now,
// which bet names come back, an example, and the open tips with/without odds.
async function apiOddsProbe(env) {
  if (!afOn(env)) return { key: false };
  const src = afSource(env);
  const [live, raw] = await Promise.all([src.live(), fetchApiFootball(env, "odds/live", null)]);
  if (!raw) return { key: true, ok: false };
  const names = {};
  let withOu = 0;
  let sample = null;
  for (const e of raw) {
    for (const b of e.odds || []) names[b.name] = (names[b.name] || 0) + 1;
    const lines = afOddsLines(e);
    if (Object.keys(lines).length) {
      withOu++;
      if (!sample) sample = { fixture: e.fixture && e.fixture.id, lines };
    }
  }
  const ids = new Map(raw.map((e) => [e.fixture && e.fixture.id, afOddsLines(e)]));
  const openTips = (await readTracked(env)).filter((t) => !t.settledKey);
  // Matches of open tips that are not in the live list: are they in today's (or yesterday's) fixture list at all?
  const needDay = openTips.some((t) => !(t.afId || findApiMatch(live, t.home, t.away)));
  const day = needDay ? await src.day(new Date().toISOString().slice(0, 10)) : null;
  const open = openTips.map((t) => {
    const hit = (t.afId && live && live.find((x) => x.afId === t.afId)) || findApiMatch(live, t.home, t.away);
    const fid = t.afId || (hit && hit.afId) || null;
    const inDay = !fid && day ? findApiMatch(day, t.home, t.away) : null;
    // Not found: show day-list matches that share one team, to tell missing leagues from name spellings.
    const near = !fid && !inDay && day
      ? day.filter((f) => sameTeam(f.h, t.home) || sameTeam(f.a, t.away)).slice(0, 2).map((f) => `${f.h} – ${f.a}`)
      : [];
    return {
      match: `${t.home} – ${t.away}`, line: t.line, afId: fid, live: !!hit, inDay: !!inDay, near,
      ageMin: Math.round((Date.now() - t.postedAt) / 60000),
      odds: fid && ids.has(fid) ? Object.keys(ids.get(fid)).length > 0 : false,
    };
  });
  const today = new Date().toISOString().slice(0, 10);
  let stored = 0;
  try {
    stored = JSON.parse((await env.ACCESS_KV.get("afm:" + today)) || "[]").length;
  } catch (e) {}
  if (sample) {
    const f = live && live.find((x) => x.afId === sample.fixture);
    if (f) sample.match = `${f.h} – ${f.a} (${f.c || ""} · ${f.lg || ""}, ${f.minute}')`;
  }
  const topNames = Object.entries(names).sort((a, b) => b[1] - a[1]).slice(0, 12);
  return { key: true, ok: true, live: live ? live.length : null, withOdds: raw.length, withOu, topNames, sample, open, storedToday: stored };
}

async function findApiFixture(env, src, t, now) {
  const live = await src.live();
  let af = live ? (t.afId ? live.find((x) => x.afId === t.afId) : findApiMatch(live, t.home, t.away)) : null;
  if (!af && t.afId) af = await src.byId(t.afId);
  const lookDay = !af && !t.afId && now - t.postedAt >= AF_DAY_AFTER_MS && (!t.dayTriedAt || now - t.dayTriedAt >= AF_DAY_RETRY_MS);
  if (lookDay) {
    t.dayTriedAt = now;
    t._dayTried = true;
    const date = new Date(t.postedAt - 70 * 60 * 1000).toISOString().slice(0, 10); // kickoff day (UTC)
    af = findApiMatch(await src.day(date), t.home, t.away);
  }
  // A match that never finishes there (suspended, interrupted) is void after 12 h.
  if (af && !af.finished && !af.voided && now - t.postedAt > 12 * 60 * 60 * 1000) af = { ...af, voided: true };
  return af || null;
}

// Minute of the goal the tip needed (the (line + 0.5)-th goal), when API-Football lists all goals.
function afGoalMinute(t, af) {
  if (t.under || !af.goalMinutes) return null;
  const gm = af.goalMinutes[Math.round(t.line - 0.5)];
  return gm != null && (t.minute == null || gm >= t.minute - 1) ? gm : null;
}

async function settleTracked(env, feed, srcIn = null) {
  const open = await readTracked(env);
  const feedDown = !Array.isArray(feed);
  if (!open.length || (feedDown && !afOn(env))) return;
  if (feedDown) feed = [];
  const src = afOn(env) ? srcIn || afSource(env) : null;
  const now = Date.now();
  let changed = false;
  const keep = [];
  const settled = new Set(); // duplicates of a tip settled in this run are dropped silently
  const warnTiers = new Set();
  for (const t of open) {
    const m = findTrackedMatch(feed, t);
    const af = !m && src ? await findApiFixture(env, src, t, now) : null;
    if (af && t.afId !== af.afId) {
      t.afId = af.afId;
      changed = true;
    }
    if (t._dayTried) {
      delete t._dayTried;
      changed = true; // remember the throttle
    }
    // Real live odds while the tip is open (since 01.11.): fixture id from the live list if the
    // match came from the InPlayFlux feed, then the over/under lines from odds/live.
    if (src && !t.settledKey && !t.under) {
      if (!t.afId && m) {
        const hit = findApiMatch(await src.live(), t.home, t.away);
        if (hit) {
          t.afId = hit.afId;
          changed = true;
        }
      }
      const live = af || m;
      if (t.afId && live && !(af && (af.finished || af.voided))) {
        const odds = await src.odds();
        const lines = odds && odds.get(t.afId);
        if (lines && recordOdds(t, lines, num(live.minute), now)) changed = true;
      }
    }
    const seenGoals = m ? (num(m.hg) || 0) + (num(m.ag) || 0) : af ? af.goals : null;
    if (seenGoals != null && t.lastGoals !== seenGoals) {
      t.lastGoals = seenGoals; // last score seen, becomes the final score (finalGoals)
      changed = true;
    }
    if (af && t.settledKey && (af.finished || af.voided)) {
      // API-Football has the final score: log it and stop watching.
      if (af.finished) await addFinalGoals(env, t.settledKey, af.goals);
      changed = true;
      continue;
    }
    if (af && !t.settledKey && (af.finished || af.voided)) {
      const k = tipKey(t.tier, t.home, t.away, t.line);
      if (settled.has(k)) {
        changed = true;
        continue;
      }
      settled.add(k);
      changed = true;
      let result = "void";
      if (af.finished) {
        const over = af.goals > t.line;
        result = t.under ? (over ? "lost" : "won") : over ? "won" : "lost";
        t.resultMinute = over ? afGoalMinute(t, af) : null;
        t.goalExact = t.resultMinute != null;
        warnTiers.add(t.tier);
      }
      await saveResult(env, t, result, af.finished ? af.goals : null);
      try {
        await markPremiumPost(env, t, result);
      } catch (e) {}
      try {
        await maybePostFree(env, t, result);
      } catch (e) {}
      continue;
    }
    if (t.settledKey) {
      if (af) {
        // Still running at API-Football: watch on (late flag only matters without it).
        keep.push(t);
        continue;
      }
      if (feedDown) {
        keep.push(t);
        continue;
      }
      // Already settled by its goal: keep watching only to log the final score.
      const fin = watchFinal(t, m, now);
      if (fin === "keep") keep.push(t);
      else if (fin === "final") await addFinalGoals(env, t.settledKey, t.lastGoals);
      if (fin !== "keep" || t._changed) changed = true;
      delete t._changed;
      continue;
    }
    const k = tipKey(t.tier, t.home, t.away, t.line);
    if (settled.has(k)) {
      changed = true;
      continue;
    }
    let result = null;
    if (af) {
      // Live at API-Football (not finished): decided as soon as the needed goal falls.
      if (af.goals > t.line) {
        result = t.under ? "lost" : "won";
        t.resultMinute = afGoalMinute(t, af);
        t.goalExact = t.resultMinute != null;
      }
      if (t.missingSince) {
        delete t.missingSince;
        changed = true;
      }
    } else if (feedDown) {
      // InPlayFlux down and not (yet) found at API-Football: wait.
    } else if (m) {
      const goals = seenGoals;
      const minute = num(m.minute);
      if (goals > t.line) {
        result = t.under ? "lost" : "won";
        // The guest feed often shows a match only near the end: take the
        // feed's last-goal minute when exactly the one needed goal fell.
        const lastGoal = num(m.sonGolDakikasi);
        t.goalExact = !t.under && goals === t.line + 0.5 && lastGoal != null && lastGoal > 0 && (t.minute == null || lastGoal >= t.minute);
        t.resultMinute = t.goalExact ? lastGoal : null; // unknown which goal came first
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
      if (result !== "void") warnTiers.add(t.tier);
      const decidedLate = !m && !af && t.late; // match gone after 85': last score seen is the final score
      const resultKey = await saveResult(env, t, result, decidedLate && t.lastGoals != null ? t.lastGoals : null);
      // Decided by a goal while the match runs: watch on until full time for the final score.
      if ((m || af) && result !== "void") {
        delete t.late;
        delete t.missingSince;
        t.settledKey = resultKey;
        t.result = result;
        keep.push(t);
      }
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
  if (warnTiers.size) {
    try {
      await maybeWarn(env, warnTiers);
    } catch (e) {}
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

// Early warning to the owner (ADMIN_CHAT_ID). After a tip settles, the last
// WARN_WINDOW decided tips of its tier are compared with the expected hit rate:
// fewer wins than expected minus 2 standard deviations (about a 1-in-40 chance
// if nothing changed), or a loss over the last bets with the "wait for 1.40"
// entry, sends one message per tier and day (warn:<tier>:<day>).
const WARN_WINDOW = 30;
const WARN_MIN = 20;
const WARN_EXPECTED = { premium: 0.786, half: 0.65, o15: 0.76, under: 0.68, risk: 0.6 };
const WARN_LABEL = { premium: "🔥 High Confidence", half: "🟠 Half-Risiko", o15: "🧪 Over 1.5 Test", under: "🛡️ Under 3.5", risk: "⚠️ Risiko" };
async function maybeWarn(env, tiers) {
  if (!env.ADMIN_CHAT_ID || !env.TELEGRAM_BOT_TOKEN) return;
  const day = new Date().toISOString().slice(0, 10);
  const todo = [];
  for (const tier of tiers) {
    if (!WARN_EXPECTED[tier] || (await env.ACCESS_KV.get(`warn:${tier}:${day}`))) continue;
    todo.push(tier);
  }
  if (!todo.length) return;
  const rows = await listResults(env, Date.now() - 30 * DAY_MS); // newest first
  for (const tier of todo) {
    const last = rows.filter((r) => r.tier === tier && (r.result === "won" || r.result === "lost")).slice(0, WARN_WINDOW);
    if (last.length < WARN_MIN) continue;
    const n = last.length;
    const won = last.filter((r) => r.result === "won").length;
    const p = WARN_EXPECTED[tier];
    const floor = n * p - 2 * Math.sqrt(n * p * (1 - p));
    const bets = last.filter((r) => r.wait && r.wait.bet && r.wait.profit != null);
    const waitProfit = Math.round(bets.reduce((a, r) => a + r.wait.profit, 0) * 100) / 100;
    const reasons = [];
    if (won < floor) reasons.push(`nur ${won} von ${n} getroffen (${Math.round((won / n) * 100)} %, erwartet ~${Math.round(p * 100)} %)`);
    if (bets.length >= WARN_MIN && waitProfit < 0) reasons.push(`mit Einstieg ab Quote 1,40 (geschätzt) ${String(waitProfit).replace(".", ",")} Einheiten bei ${bets.length} Einsätzen`);
    if (!reasons.length) continue;
    await env.ACCESS_KV.put(`warn:${tier}:${day}`, "1", { expirationTtl: 2 * DAY_MS / 1000 });
    await sendTelegramMessage(env, env.ADMIN_CHAT_ID,
      `⚠️ Frühwarnung: ${WARN_LABEL[tier]}\nLetzte ${n} Tipps: ${reasons.join("; ")}.\n\nBitte prüfen: ${RESULTS_PAGE_URL}\nZufall ist möglich (etwa 1 zu 40). Wenn es anhält: Stufe strenger machen oder abschalten.`);
  }
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

// Final score of a settled tip (since 01.11., for testing lines like Over 3.0 on real
// outcomes): after the deciding goal the tip stays in track:open with settledKey and is
// watched like an open one; when the match is gone after 85' the last score seen is the
// final one. Returns "keep", "final" (write finalGoals) or "drop" (never seen late).
function watchFinal(t, m, now) {
  if (m) {
    const minute = num(m.minute);
    if (minute != null && minute >= TRACK_LOST_AFTER_MIN && !t.late) {
      t.late = true;
      t._changed = true;
    }
    if (t.missingSince) {
      delete t.missingSince;
      t._changed = true;
    }
    return "keep";
  }
  if (t.late) {
    if (!t.missingSince) {
      t.missingSince = now;
      t._changed = true;
      return "keep";
    }
    return now - t.missingSince >= TRACK_MISSING_GRACE_MS ? "final" : "keep";
  }
  return now - t.postedAt >= TRACK_GIVE_UP_MS ? "drop" : "keep";
}

async function addFinalGoals(env, key, goals) {
  if (!key || goals == null) return;
  const raw = await env.ACCESS_KV.get(key);
  if (!raw) return;
  let record;
  try {
    record = JSON.parse(raw);
  } catch (e) {
    return;
  }
  if (record.finalGoals === goals) return;
  record.finalGoals = goals;
  await env.ACCESS_KV.put(key, JSON.stringify(record), { expirationTtl: 365 * 24 * 60 * 60, metadata: resultMeta(record) });
}

// Odds log of a tip (t.ol): first sighting (minute, lines from line − 0.5 to line + 1), the highest
// over price of the tip's own line and its minute, and the first minute it reached 1.40 (the owner's
// "wait for 1.40" entry). Returns true when something new was stored.
function recordOdds(t, lines, minute, now) {
  let changed = false;
  if (!t.ol) {
    const f = {};
    for (const [k, v] of Object.entries(lines)) {
      const h = Number(k);
      if (h >= t.line - 0.5 && h <= t.line + 1) f[k] = v;
    }
    if (!Object.keys(f).length) return false;
    t.ol = { m: minute, at: now, f };
    changed = true;
  }
  const own = lines[String(t.line)];
  const over = own && own.o;
  if (over != null) {
    if (t.ol.mx == null || over > t.ol.mx) {
      t.ol.mx = over;
      t.ol.mxm = minute;
      changed = true;
    }
    if (over >= WAIT_QUOTE && t.ol.r140 == null) {
      t.ol.r140 = minute;
      changed = true;
    }
  }
  return changed;
}

// Scalar odds fields for the result record and its metadata (CSV, analysis).
function oddsFields(t) {
  const ol = t.ol;
  if (!ol) return {};
  const at = (h) => ol.f[String(h)] || {};
  return {
    oddsMinute: ol.m, oddsOver: at(t.line).o ?? null, oddsUnder: at(t.line).u ?? null,
    oddsMax: ol.mx ?? null, oddsMaxMinute: ol.mxm ?? null, odds140Minute: ol.r140 ?? null,
    oddsQuarterOver: at(t.line + 0.25).o ?? null, oddsNextOver: at(t.line + 0.5).o ?? null, oddsNextUnder: at(t.line + 0.5).u ?? null,
  };
}

async function saveResult(env, t, result, finalGoals = null) {
  const now = new Date();
  // Profit in units only where the logged quote is for the signal's own line.
  const quoteSide = t.under ? "under" : "over";
  // Feed quote for the tip's own line if logged, else the quote from the card
  // (since 22.10., estimated when the card's live line differs).
  const feedQuote = t.odds && t.odds.line === t.line && t.odds[quoteSide] ? t.odds[quoteSide] : null;
  const card = !t.under && t.signalQuote && t.signalQuote.over ? t.signalQuote : null;
  const priced = feedQuote != null ? feedQuote : card ? card.over : null;
  const quoteEstimated = feedQuote == null && card ? !card.exact : false;
  const betPlaced = priced != null && priced >= t.minQuote;
  let profit = null;
  if (betPlaced && result !== "void") profit = result === "won" ? t.units * (priced - 1) : -t.units;
  const record = {
    tier: t.tier, home: t.home, away: t.away, line: t.line, minute: t.minute,
    postedAt: new Date(t.postedAt).toISOString(), settledAt: now.toISOString(),
    result, resultMinute: t.resultMinute != null ? t.resultMinute : null,
    units: t.units, minQuote: t.minQuote, quote: priced, quoteEstimated, betPlaced,
    wait: waitOutcome(t, result),
    // Market's fair probability for the tip at signal time (from the card, margin removed).
    marketP: !t.under && t.signalQuote && t.signalQuote.p ? t.signalQuote.p : null,
    profit: profit != null ? Math.round(profit * 100) / 100 : null,
    finalGoals,
    ...oddsFields(t),
    liveOdds: t.ol || null,
  };
  // The record is also stored as key metadata, so listing results (public
  // results page, reports) needs one KV list call per 1000 tips, not one get each.
  const key = `result:${now.getTime()}:${t.id}`;
  await env.ACCESS_KV.put(key, JSON.stringify(record), {
    expirationTtl: 365 * 24 * 60 * 60,
    metadata: resultMeta(record),
  });
  return key;
}

const RESULT_CSV_COLS = ["postedAt", "settledAt", "tier", "home", "away", "line", "minute", "result", "resultMinute", "units",
  "minQuote", "quote", "quoteEstimated", "betPlaced", "profit", "marketP", "waitEntry", "waitBet", "waitProfit", "filledFrom", "finalGoals",
  "oddsMinute", "oddsOver", "oddsUnder", "oddsMax", "oddsMaxMinute", "odds140Minute", "oddsQuarterOver", "oddsNextOver", "oddsNextUnder"];
function resultsCsv(rows) {
  const cell = (v) => (v == null ? "" : /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v));
  const lines = rows.map((r) => {
    const w = r.wait || {};
    const x = { ...r, waitEntry: w.entry, waitBet: w.bet, waitProfit: w.profit };
    return RESULT_CSV_COLS.map((c) => cell(x[c])).join(",");
  });
  return [RESULT_CSV_COLS.join(",")].concat(lines).join("\n") + "\n";
}

// KV metadata is limited to 1024 bytes; team names are cut to stay well below.
function resultMeta(record) {
  const meta = { ...record, home: String(record.home || "").slice(0, 40), away: String(record.away || "").slice(0, 40) };
  delete meta.liveOdds; // full odds log only in the value (metadata max 1024 bytes)
  return meta;
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
  // Every tip bet at its quote at signal time, whatever the minimum quote says.
  const quoted = decided.filter((r) => r.quote != null && r.units);
  const profitAll = quoted.reduce((a, r) => a + (r.result === "won" ? r.units * (r.quote - 1) : -r.units), 0);
  return {
    all: tally(decided),
    premium: tally(decided.filter((r) => r.tier === "premium")),
    risk: tally(decided.filter((r) => r.tier === "risk")),
    half: tally(decided.filter((r) => r.tier === "half")),
    under: tally(decided.filter((r) => r.tier === "under")),
    o15: tally(decided.filter((r) => r.tier === "o15")),
    priced: priced.length,
    estimated: priced.filter((r) => r.quoteEstimated).length,
    quotedAll: quoted.length,
    profitAll: Math.round(profitAll * 100) / 100,
    stakedAll: quoted.reduce((a, r) => a + r.units, 0),
    // Hit rate vs the market's expectation at signal time, per tier: we only
    // make money over time where we hit more often than the market expects.
    market: Object.fromEntries(["premium", "half", "o15", "under"].map((tier) => {
      const m = decided.filter((r) => r.tier === tier && r.marketP != null);
      return [tier, m.length ? {
        n: m.length, won: m.filter((r) => r.result === "won").length,
        expected: Math.round((m.reduce((a, r) => a + r.marketP, 0) / m.length) * 1000) / 10,
      } : null];
    })),
    ...(() => {
      const w = decided.filter((r) => r.wait && r.wait.profit != null);
      const bets = w.filter((r) => r.wait.bet);
      return {
        waitBets: bets.length, waitWon: bets.filter((r) => r.result === "won").length,
        waitSkipped: w.filter((r) => r.wait.bet === false).length,
        waitProfit: Math.round(bets.reduce((a, r) => a + r.wait.profit, 0) * 100) / 100,
        waitStaked: bets.reduce((a, r) => a + r.units, 0),
      };
    })(),
    avgQuote: quoted.length ? Math.round((quoted.reduce((a, r) => a + r.quote, 0) / quoted.length) * 100) / 100 : null,
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
    lines.push("", `💶 Rechnerisch, mit der Quote beim Signal, nur Tipps ab Mindestquote (${sum.priced} ${sum.priced === 1 ? "Tipp" : "Tipps"}${sum.estimated ? `, ${sum.estimated} Quoten geschätzt` : ""}): ${sign}${String(sum.profit).replace(".", ",")} Einheiten (Rendite ${sign}${String(roi).replace(".", ",")} %)`);
  }
  lines.push("", "Automatisch ausgewertet aus dem Live-Spielstand. Keine Gewinngarantie, 18+.");
  return lines.join("\n");
}

// Monday check for the owner only (ADMIN_CHAT_ID): last 7 days per tier, the
// market comparison, both profit estimates and the reminder for the weekly
// routine (export a new CSV at InPlayFlux and hand it to Claude).
function adminWeeklyText(sum) {
  const de = (x) => String(x).replace(".", ",");
  const sg = (x) => (x >= 0 ? "+" : "") + de(x);
  const lines = ["🗓️ Wochen-Check (nur für dich, letzte 7 Tage)", ""];
  for (const [key, label] of RESULT_TIERS) {
    const t = sum[key];
    if (!t || !t.n) continue;
    const m = sum.market && sum.market[key];
    const mk = m ? ` · Markt erwartete ${de(m.expected)} % → ${sg(Math.round((m.won / m.n * 100 - m.expected) * 10) / 10)} Punkte` : "";
    lines.push(`${label}: ${pctText(t)}${mk}`);
  }
  if (!sum.all.n) lines.push("Keine entschiedenen Tipps.");
  if (sum.quotedAll) lines.push("", `Jeder Tipp zur Quote beim Signal (${sum.quotedAll}): ${sg(sum.profitAll)} Einheiten`);
  if (sum.waitBets) lines.push(`Warten bis Quote 1,40 (geschätzt, ${sum.waitBets} Einsätze, ${sum.waitSkipped} Tore kamen vorher): ${sg(sum.waitProfit)} Einheiten`);
  lines.push("", "📥 Wochen-Routine: Bitte bei InPlayFlux den CSV-Export der letzten Woche herunterladen und Claude geben. Claude kalibriert neu und schaltet schwache Stufen ab.");
  lines.push("🖼️ Wochenbild: Admin → „Bilanz-Grafik erstellen (7 Tage)“ → „An Gratis-Kanal senden“.");
  return lines.join("\n");
}

// Morning report for the owner (ADMIN_CHAT_ID), every day except Monday (the
// weekly check covers it): yesterday's tips per tier, profit estimates, open
// tips, and lines that got no tips although they usually do (a switched-off
// InPlayFlux strategy showed up like that on 17.10.).
const LINE_NAMES = { 0.5: "Over 0.5 (Tor bei 0:0)", 1.5: "Over 1.5", 2.5: "Over 2.5", 3.5: "Over 3.5" };
function dailyAdminText(rows, now, openCount) {
  const de = (x) => String(x).replace(".", ",");
  const sg = (x) => (x >= 0 ? "+" : "") + de(x);
  const dayStart = now - DAY_MS;
  const yday = rows.filter((r) => Date.parse(r.settledAt) >= dayStart);
  const week = rows.filter((r) => Date.parse(r.settledAt) >= now - 7 * DAY_MS);
  const sum = summarize(yday);
  const lines = ["☀️ Tages-Bericht (nur für dich, letzte 24 Stunden)", ""];
  for (const [key, label] of RESULT_TIERS) {
    const t = sum[key];
    if (t && t.n) lines.push(`${label}: ${pctText(t)}`);
  }
  if (!sum.all.n) lines.push("Keine entschiedenen Tipps.");
  else lines.push(`Gesamt: ${pctText(sum.all)}`);
  const voids = yday.filter((r) => r.result === "void").length;
  if (voids) lines.push(`Ohne Wertung (Spiel nicht mehr im Feed): ${voids}`);
  if (sum.quotedAll) lines.push("", `Jeder Tipp zur Quote beim Signal: ${sg(sum.profitAll)} Einheiten (${sum.quotedAll} Tipps)`);
  if (sum.waitBets) lines.push(`Warten bis Quote 1,40 (geschätzt): ${sg(sum.waitProfit)} Einheiten (${sum.waitBets} Einsätze, ${sum.waitSkipped} Tore kamen vorher)`);
  lines.push(`Noch offen: ${openCount}`);
  const quiet = Object.keys(LINE_NAMES).map(Number).filter((line) => {
    const perDay = week.filter((r) => r.line === line && !r.under).length / 7;
    return perDay >= 2 && !yday.some((r) => r.line === line && !r.under);
  });
  if (quiet.length) {
    lines.push("", `⚠️ Keine Tipps mehr für ${quiet.map((l) => LINE_NAMES[l]).join(", ")} (sonst mehrere pro Tag). Bitte bei InPlayFlux unter Strategy prüfen, ob die Strategie noch eingeschaltet ist.`);
  }
  // The guest feed misses many matches (busy days: the ~15 slots are full of stoppage-time games), so voids pile up.
  // InPlayFlux does not mark cards with the result, so the owner fills them from a CSV export (owner's choice 31.10.).
  const openVoids = week.filter((r) => r.result === "void").length;
  if (openVoids >= VOID_REMIND) {
    lines.push("", `📥 ${openVoids} Tipps der letzten 7 Tage sind noch ungewertet. Bitte nachtragen: bei InPlayFlux die CSV exportieren, dann im Admin oben das Passwort eintragen → „Unklare Ergebnisse nachtragen“ → Datei wählen → Vorschau → Übernehmen.`);
  }
  lines.push("", `📋 ${RESULTS_PAGE_URL}`);
  return lines.join("\n");
}
const VOID_REMIND = 10;

async function sendDailyReport(env) {
  if (!env.ADMIN_CHAT_ID || new Date().getUTCDay() === 1) return;
  const now = Date.now();
  const [rows, open] = await Promise.all([listResults(env, now - 7 * DAY_MS), readTracked(env)]);
  await sendTelegramMessage(env, env.ADMIN_CHAT_ID, dailyAdminText(rows, now, open.filter((t) => !t.settledKey).length));
}

async function sendWeeklyReport(env) {
  const to = new Date();
  const from = new Date(to.getTime() - 7 * DAY_MS);
  const sum = summarize(await listResults(env, from.getTime()));
  if (env.ADMIN_CHAT_ID) {
    try {
      await sendTelegramMessage(env, env.ADMIN_CHAT_ID, adminWeeklyText(sum));
    } catch (e) {}
  }
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
  if (all.quotedAll >= MIN_PRICED_FOR_PROFIT) {
    const sg = all.profitAll >= 0 ? "+" : "";
    const r = all.stakedAll ? Math.round((all.profitAll / all.stakedAll) * 1000) / 10 : 0;
    profit += `<p class="note">Rechnerisch, wenn jeder Tipp zur Quote beim Signal gesetzt wurde (${all.quotedAll} Tipps seit 22.10., Ø Quote ${String(all.avgQuote).replace(".", ",")}, Quoten teils aus der Live-Linie geschätzt): <b>${sg}${String(all.profitAll).replace(".", ",")} Einheiten</b> (Rendite ${sg}${String(r).replace(".", ",")} %).</p>`;
  }
  if (all.priced >= MIN_PRICED_FOR_PROFIT) {
    const sign = all.profit >= 0 ? "+" : "";
    const roi = all.staked ? Math.round((all.profit / all.staked) * 1000) / 10 : 0;
    profit += `<p class="note">Rechnerisch, mit der Quote beim Signal, nur Tipps ab Mindestquote (${all.priced}${all.estimated ? `, davon ${all.estimated} Quoten aus der Live-Linie geschätzt` : ""}): <b>${sign}${String(all.profit).replace(".", ",")} Einheiten</b> (Rendite ${sign}${String(roi).replace(".", ",")} %).</p>`;
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
<title>MoneyBag – Alle Ergebnisse</title>${ICON_LINK}<link rel="canonical" href="https://moneybag-signals.com/ergebnisse">${ogMeta("MoneyBag – Alle Ergebnisse", "Alle abgeschlossenen Live-Fußballsignale mit Ergebnis – automatisch erfasst, nichts gelöscht.", "/ergebnisse")}<meta name="description" content="Alle abgeschlossenen MoneyBag-Signale mit Ergebnis – automatisch erfasst, nichts gelöscht.">
<style>
:root{--red:#e0262f;--ink:#111;--muted:#5d5d66;--line:#e4e4e8;--ok:#14853b;--no:#e0262f}
*{box-sizing:border-box}body{margin:0;background:#fff;color:var(--ink);font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Liberation Sans",sans-serif}
a{color:var(--red)}.wrap{max-width:900px;margin:0 auto;padding:0 18px}
.hero{background:linear-gradient(115deg,#111 0 62%,var(--red) 62% 73%,#111 73%);color:#fff;padding:22px 0 40px}
${LOGO_CSS}
h1{font-size:52px;line-height:1;margin:22px 0 12px;text-transform:uppercase;font-weight:900;letter-spacing:-1px}h1 span{color:#ff4b52}
.sub{color:#ddd;margin:0;max-width:600px}
h2{font-size:15px;font-weight:900;text-transform:uppercase;letter-spacing:3px;margin:40px 0 12px;display:flex;align-items:center;gap:12px}
h2:before{content:"";width:28px;height:6px;background:var(--red);display:inline-block;transform:skewX(-20deg)}
.card{border:2px solid var(--ink);overflow-x:auto}
table{width:100%;border-collapse:collapse}th,td{padding:10px 12px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}tr:last-child td{border-bottom:0}
th{background:#111;color:#fff;font-weight:800;font-size:13px;text-transform:uppercase;letter-spacing:1px}td small{display:block;color:var(--muted);font-size:13px}td b{font-size:18px;font-weight:900;color:var(--red)}
.rates td:not(:first-child),.rates th:not(:first-child){text-align:right}.total td{background:#f6f6f7;font-weight:800}
.ok{color:var(--ok);font-weight:800}.no{color:var(--no);font-weight:800}.void{color:var(--muted)}
.days{display:flex;gap:6px;align-items:flex-end;padding:14px 12px}.day{flex:1;text-align:center;min-width:0}.day small{display:block;color:var(--muted);font-size:11px;white-space:nowrap}
.stack{height:110px;display:flex;flex-direction:column-reverse;background:#f2f2f4}.stack .w{background:#111}.stack .l{background:var(--red)}
.note{color:var(--muted);font-size:14px}.cta{display:inline-block;margin-top:8px;background:var(--red);color:#fff;font-weight:900;padding:14px 20px;text-decoration:none;text-transform:uppercase;letter-spacing:1px}
.cta.k{background:#111}
footer{margin-top:44px;background:#111;color:#aaa;font-size:13px;padding:22px 0 30px}footer a{color:#ddd}
@media(max-width:520px){h1{font-size:31px}.hero{background:linear-gradient(115deg,#111 0 74%,var(--red) 74% 84%,#111 84%)}th,td{padding:9px 6px;font-size:14px}td b{font-size:15px}.rates b,.rates small{white-space:nowrap}.day small:first-of-type{display:none}}
</style></head><body>
<header class="hero"><div class="wrap">${LOGO_HTML}
<h1>Alle <span>Ergebnisse</span></h1>
<p class="sub">Jedes Premium-Signal mit Ergebnis – automatisch aus dem Live-Spielstand erfasst. Nichts gelöscht, nichts ausgewählt. Stand: ${updated}</p></div></header>
<main class="wrap">
<h2>Trefferquote</h2><div class="card"><table class="rates">${head}${body}</table></div>
${profit}
<p class="note">Treffer = das gesuchte Tor fiel (bei „Under 3.5“: kein weiteres Tor). Ungewertete Spiele (Abbruch, Daten fehlen) zählen nicht mit.</p>
<h2>Letzte 14 Tage</h2><div class="card"><div class="days">${bars}</div></div>
<p class="note">Schwarz = Treffer, Rot = verloren. Zahl = Treffer/Signale.</p>
<h2>Alle Signale${rows.length > RESULTS_PAGE_ROWS ? ` (neueste ${RESULTS_PAGE_ROWS} von ${rows.length})` : ""}</h2>
<div class="card"><table><tr><th>Zeit</th><th>Spiel</th><th>Ergebnis</th></tr>${list || '<tr><td colspan="3">Noch keine abgeschlossenen Signale.</td></tr>'}</table></div>
<h2>Selbst verfolgen</h2>
<p>3 Signale pro Tag gratis (mit Ergebnis) und die Wochenbilanz im Telegram-Kanal – oder Premium 24 Stunden kostenlos testen:</p>
<a class="cta" href="${freeLink}">📢 Gratis-Kanal öffnen</a> <a class="cta k" href="/#test">🎁 24 h gratis testen</a>
</main>
<footer><div class="wrap">18+ · Sportwetten bergen Verlustrisiken · Keine Gewinngarantie · Vergangene Ergebnisse sagen nichts über künftige aus.<br>Hilfe bei Glücksspielproblemen: <a href="https://www.check-dein-spiel.de">check-dein-spiel.de</a> · BZgA-Hotline 0800 1 37 27 00<br><a href="/">Startseite</a> · <a href="/videos">Videos</a> · <a href="/partner">Partner</a>${env.IMPRESSUM_NAME && env.IMPRESSUM_ADDRESS ? ' · <a href="/impressum">Impressum</a> · <a href="/agb">AGB</a> · <a href="/widerruf">Widerrufsbelehrung</a> · <a href="/datenschutz">Datenschutz</a>' : ""}</div></footer>
</body></html>`;
}

// Shared "Sport-Magazin" look (design 6, 26.10.) for the simple text pages: Impressum, AGB, Widerruf, Datenschutz, access page.
// Logo "Speed" (owner's pick 26.10.): three red speed lines + italic MONEY (white) BAG (red), plain CSS, no font files
const LOGO_CSS = `.logo{display:inline-flex;align-items:center;font:italic 900 26px/1 Arial,"Liberation Sans",Helvetica,sans-serif;letter-spacing:-1px;color:#fff;text-decoration:none;text-transform:uppercase}.logo span{color:#ff4b52}
.logo i{width:34px;height:15px;margin-right:4px;flex:none;background:linear-gradient(#ff4b52,#ff4b52) 6px 0/26px 3px no-repeat,linear-gradient(#ff4b52,#ff4b52) 0 6px/34px 3px no-repeat,linear-gradient(#ff4b52,#ff4b52) 10px 12px/22px 3px no-repeat}
.topbar{display:flex;align-items:center;gap:14px;position:relative;z-index:20}
.mnav summary{list-style:none;cursor:pointer;height:52px;display:flex;align-items:center;gap:8px;padding:0 10px 0 6px;border:2px solid #fff;-webkit-tap-highlight-color:transparent}
.mnav summary em{writing-mode:vertical-rl;transform:rotate(180deg);font:normal 900 10px/1 Arial,"Liberation Sans",sans-serif;letter-spacing:2px;text-transform:uppercase;color:#fff}
.mnav summary span{width:24px;display:flex;flex-direction:column;gap:6px}
.mnav summary::-webkit-details-marker{display:none}.mnav summary b{display:block;height:3px;background:#fff}.mnav summary b:nth-child(2){background:#ff4b52}
.mnav[open] summary{background:#ff4b52;border-color:#ff4b52}.mnav[open] summary b{background:#fff}
.mnav nav{position:absolute;top:62px;left:0;width:290px;max-width:calc(100vw - 32px);max-height:75vh;overflow-y:auto;background:#111;border:2px solid #fff;border-left:6px solid #ff4b52;padding:8px 0 12px;box-shadow:8px 8px 0 rgba(0,0,0,.35);font:16px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Liberation Sans",sans-serif;text-transform:none;letter-spacing:0}
.mnav nav p{margin:12px 18px 4px;color:#ff4b52;font-size:11px;font-weight:900;letter-spacing:2px;text-transform:uppercase}
.mnav nav a{display:block;padding:10px 18px;color:#fff;text-decoration:none;font-weight:700}.mnav nav a:hover,.mnav nav a:focus{background:#ff4b52;color:#fff}`;
// Fold-out menu next to the logo on every public page (since 30.10., owner: "schnelles Navigieren"). Pure HTML
// <details>, no script needed; a tap on a link also closes it (same-page anchors). New public pages go into NAV_LINKS (legal pages stay in the footers).
const NAV_LINKS = [
  ["Start", [["/", "🏠 Startseite"], ["/#daten", "📈 Daten der Woche"], ["/#so", "⚙️ So funktioniert's"], ["/#faq", "❓ Häufige Fragen"]]],
  ["Zahlen & Inhalte", [["/ergebnisse", "📊 Alle Ergebnisse"], ["/videos", "🎬 Daten-Videos"]]],
  ["Mitmachen", [["/#test", "🎁 24 h gratis testen"], ["/#preis", "🔒 Premium & Preis"], ["https://t.me/MoneyBagAnalyst", "📢 Gratis-Kanal (Telegram)"], ["/partner", "🤝 Partner-Netzwerk"], ["/partner#mitmachen", "✍️ Partner werden"]]],
];
const NAV_HTML = `<details class="mnav"><summary aria-label="Menü öffnen"><em>Menü</em><span><b></b><b></b><b></b></span></summary><nav>${NAV_LINKS.map(([group, links]) =>
  `<p>${group}</p>${links.map(([href, label]) => `<a href="${href}" onclick="this.closest('details').open=false"${href.startsWith("http") ? ' rel="noopener" target="_blank"' : ""}>${label}</a>`).join("")}`).join("")}</nav></details>`;
const LOGO_HTML = `<div class="topbar">${NAV_HTML}<a class="logo" href="/" aria-label="MoneyBag Startseite"><i></i>MONEY<span>BAG</span></a></div>`;
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#111"/><g fill="#e0262f"><rect x="4" y="18" width="14" height="5"/><rect x="0" y="29" width="18" height="5"/><rect x="6" y="40" width="12" height="5"/></g><text x="40" y="45" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-weight="900" font-style="italic" font-size="31" fill="#fff" letter-spacing="-2">M<tspan fill="#e0262f">B</tspan></text></svg>`;
const ICON_LINK = `<link rel="icon" href="/favicon.svg" type="image/svg+xml">`;
// Link previews (Telegram, WhatsApp, Google): Open Graph tags + the 1200x630 image worker/public/og.png
// (source marketing/og-bild.html). Only public, indexable pages use this.
const ogMeta = (title, desc, path) => `<meta property="og:type" content="website"><meta property="og:site_name" content="MoneyBag">
<meta property="og:locale" content="de_DE"><meta property="og:title" content="${title}"><meta property="og:description" content="${desc}">
<meta property="og:url" content="https://moneybag-signals.com${path}"><meta property="og:image" content="https://moneybag-signals.com/og.png">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:card" content="summary_large_image">`;

const MAG_CSS = `:root{--red:#e0262f;--ink:#111;--muted:#5d5d66;--line:#e4e4e8}
*{box-sizing:border-box}body{margin:0;background:#fff;color:var(--ink);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Liberation Sans",sans-serif}
a{color:var(--red)}.wrap{max-width:780px;margin:0 auto;padding:0 18px}
.hero{background:linear-gradient(115deg,#111 0 64%,var(--red) 64% 75%,#111 75%);color:#fff;padding:20px 0 30px}
${LOGO_CSS}
.hero h1{font-size:38px;line-height:1.05;margin:18px 0 0;text-transform:uppercase;font-weight:900;letter-spacing:-.5px}
main h1{display:none}main h2{font-size:14px;font-weight:900;text-transform:uppercase;letter-spacing:2px;margin:32px 0 8px;display:flex;align-items:center;gap:10px}
main h2:before{content:"";width:22px;height:5px;background:var(--red);display:inline-block;transform:skewX(-20deg);flex:none}
main p{color:#222}.note{color:var(--muted);font-size:14px}
footer{margin-top:40px;background:#111;color:#aaa;font-size:13px;padding:20px 0 28px}footer a{color:#ddd}
@media(max-width:520px){.hero h1{font-size:28px}.hero{background:linear-gradient(115deg,#111 0 76%,var(--red) 76% 86%,#111 86%)}}`;
const magHead = (title) => `<header class="hero"><div class="wrap">${LOGO_HTML}<h1>${title}</h1></div></header>`;
const MAG_FOOT = `<footer><div class="wrap">18+ · Keine Gewinngarantie · MoneyBag ist kein Wettanbieter.<br><a href="/">Startseite</a> · <a href="/ergebnisse">Ergebnisse</a> · <a href="/videos">Videos</a> · <a href="/partner">Partner</a> · <a href="/impressum">Impressum</a> · <a href="/agb">AGB</a> · <a href="/widerruf">Widerrufsbelehrung</a> · <a href="/datenschutz">Datenschutz</a></div></footer>`;

// Legal notice (§ 5 DDG). Name and postal address come from the Cloudflare
// variables IMPRESSUM_NAME and IMPRESSUM_ADDRESS (address lines separated by
// "|"), so the owner's address is never in the repository; IMPRESSUM_EMAIL is
// optional. Without name and address the page does not exist (404).
function impressumPage(env) {
  if (!env.IMPRESSUM_NAME || !env.IMPRESSUM_ADDRESS) return new Response("Not found", { status: 404 });
  const email = env.IMPRESSUM_EMAIL || CONTACT_EMAIL;
  const addr = String(env.IMPRESSUM_ADDRESS).split("|").map((l) => htmlEsc(l.trim())).join("<br>");
  const html = `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MoneyBag – Impressum</title>${ICON_LINK}<meta name="robots" content="noindex">
<style>${MAG_CSS}</style></head><body>${magHead("Impressum")}<main class="wrap">
<h1>Impressum</h1>
<h2>Angaben gemäß § 5 DDG</h2>
<p>${htmlEsc(env.IMPRESSUM_NAME)}<br>${addr}</p>
<h2>Kontakt</h2>
<p>E-Mail: <a href="mailto:${htmlEsc(email)}">${htmlEsc(email)}</a></p>
<h2>Verantwortlich für den Inhalt nach § 18 Abs. 2 MStV</h2>
<p>${htmlEsc(env.IMPRESSUM_NAME)}, Anschrift wie oben</p>
<h2>Hinweis zum Angebot</h2>
<p>MoneyBag veröffentlicht statistische Auswertungen und Einschätzungen zu Fußballspielen. MoneyBag ist kein Wettanbieter, nimmt keine Wetten an und vermittelt keine Wetten. Jede Wette erfolgt auf eigenes Risiko bei einem Anbieter der eigenen Wahl. Vergangene Ergebnisse sagen nichts über künftige aus; es gibt keine Gewinngarantie. Teilnahme erst ab 18 Jahren. Hilfe bei Glücksspielproblemen: <a href="https://www.check-dein-spiel.de">check-dein-spiel.de</a> · BZgA-Hotline 0800 1 37 27 00.</p>
<h2>Verbraucherstreitbeilegung</h2>
<p>Wir sind nicht bereit und nicht verpflichtet, an Streitbeilegungsverfahren vor einer Verbraucherschlichtungsstelle teilzunehmen.</p>
</main>${MAG_FOOT}</body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS } });
}

// Public start page for visitors without an access link (and for Google). Live hit rates from
// result:*, cached like the results page. Visitors with a token or cookie still get the tool.
// Public contact address (Cloudflare Email Routing on the domain forwards it to the owner's mailbox, since 26.10.).
const CONTACT_EMAIL = "kontakt@moneybag-signals.com";

// "/videos" (since 2026-10-30, owner's choice): MoneyBag versions of the statistics videos (same numbers as the
// Torminute videos, MoneyBag brand, no Torminute name; built by marketing/moneybag-videos.mjs into public/videos/).
// Served from our own assets: no YouTube/TikTok player, no cookies. Newest first.
const VIDEOS = [
  ["elfmeter", "Elfmeter = sicheres Tor?"],
  ["jugend", "Jugend gegen Herren: Wer trifft öfter?"],
  ["abseits", "Abseits! Kennst du die Regel wirklich?"],
  ["nutzen", "Bauchgefühl oder Daten?"],
  ["methode", "Wie entstehen unsere Zahlen?"],
  ["knapp", "Knapp oder klar – wann fällt das nächste Tor?"],
  ["trainer", "3 Trainer-Sprüche im Daten-Check"],
  ["ecken", "Viele Ecken = viele Tore?"],
  ["frauen", "Frauen oder Männer – wer trifft öfter?"],
  ["sicher", "73 % – klingt sicher. Ist es das?"],
  ["joker", "Der Joker kommt – fällt jetzt noch ein Tor?"],
  ["laender", "In welchem Land fällt am häufigsten noch ein Tor?"],
  ["nullnull", "0:0 nach 60 Minuten – fällt noch ein Tor?"],
  ["mythen", "3 Mythen über Tore im Daten-Check"],
  ["tore", "Das späte Tor ist kein Zufall"],
];
function videosPage() {
  const cards = VIDEOS.map(([slug, title]) => `<figure class="vid"><video controls playsinline muted preload="none" poster="/videos/${slug}.jpg" src="/videos/${slug}.mp4"></video><figcaption>${title}</figcaption></figure>`).join("");
  const html = `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MoneyBag – Daten-Videos</title>${ICON_LINK}<link rel="canonical" href="https://moneybag-signals.com/videos"><meta name="description" content="Kurze Videos mit eigenen Fußball-Auswertungen aus über 14.000 Live-Signalen: wann Tore fallen, Mythen im Daten-Check, Länder, Jugend und mehr.">
${ogMeta("MoneyBag – Daten-Videos", "Kurze Videos mit eigenen Fußball-Auswertungen: wann Tore fallen, Mythen im Daten-Check und mehr.", "/videos")}
<style>${MAG_CSS}
.vids{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px;margin-top:20px}
.vid{margin:0}.vid video{width:100%;aspect-ratio:9/16;background:#111;display:block}.vid figcaption{font-weight:900;font-size:15px;margin-top:8px;line-height:1.3}
.cta{background:#111;color:#fff;padding:20px;margin-top:30px}.cta a{color:#ff6b72;font-weight:900}</style></head><body>${magHead("Daten-Videos")}<main class="wrap">
<p style="margin-top:22px">Kurze Videos mit unseren eigenen Auswertungen – nur Zahlen, keine Tipps. Jede Zahl wurde in beiden Hälften des Zeitraums geprüft; die Datenbasis steht am Ende jedes Videos.</p>
<div class="vids">${cards}</div>
<div class="cta">Neue Auswertung jede Woche: <a href="/#daten">Daten der Woche</a> · Alle Signale mit Ergebnis: <a href="/ergebnisse">Ergebnisse</a> · <a href="/#test">24 h gratis testen</a></div>
</main>${MAG_FOOT}</body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=600" } });
}

// "/partner" (since 2026-10-30, owner's idea): network of trusted Telegram channels that recommend each other
// (cross-promotion). Marked as advertising/mutual recommendation (UWG § 5a). Partners are added by hand after the
// owner checked them: [name, t.me link, description, topic, banner file in public/partner/ or ""]. Banners are served
// from our own assets (no Telegram images embedded, so the privacy policy stays as it is).
const PARTNERS = [];
const PARTNER_RULES = [
  "zeigt Gewinne <b>und</b> Verluste – nicht nur Treffer",
  "verspricht keine sicheren Gewinne",
  "keine „Fixed Matches“, keine Vorkasse-Angebote",
  "weist auf 18+ und verantwortungsvolles Spielen hin",
  "ist seit mindestens etwa einem Monat aktiv",
];
const partnerChannel = (v) => {
  const s = String(v || "").trim();
  let m = s.match(/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/(\+?[A-Za-z0-9_-]{4,64})\/?$/i);
  if (m) return "https://t.me/" + m[1];
  m = s.match(/^@?([A-Za-z][A-Za-z0-9_]{4,31})$/);
  return m ? "https://t.me/" + m[1] : null;
};
function partnerPage() {
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const cards = PARTNERS.map(([name, link, text, topic, banner]) => `<div class="pc">${banner ? `<img src="/partner/${esc(banner)}" alt="${esc(name)}" loading="lazy">` : `<div class="pn">${esc(name)}</div>`}
<div class="pb"><small>${esc(topic)}</small><h3>${esc(name)}</h3><p>${esc(text)}</p><a class="btn k" href="${esc(link)}" rel="noopener sponsored" target="_blank">Zum Kanal →</a></div></div>`).join("");
  const html = `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MoneyBag – Partner-Netzwerk</title>${ICON_LINK}<link rel="canonical" href="https://moneybag-signals.com/partner"><meta name="description" content="Partner-Netzwerk seriöser Telegram-Kanäle rund um Fußball-Statistik: gegenseitige Empfehlung, klare Regeln, offene Ergebnisse.">
${ogMeta("MoneyBag – Partner-Netzwerk", "Seriöse Telegram-Kanäle, die sich gegenseitig empfehlen – mit klaren Regeln.", "/partner")}
<style>${MAG_CSS}
.ad{display:inline-block;background:#111;color:#fff;font-weight:900;font-size:12px;letter-spacing:2px;text-transform:uppercase;padding:4px 10px;margin-top:22px}
.why{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;margin-top:12px}.why>div{background:#fff;border-left:6px solid var(--red);padding:14px 16px}.why h3{margin:0 0 6px;font-size:17px}.why p{margin:0}
.rules{list-style:none;padding:0;margin:12px 0 0}.rules li{padding:8px 0 8px 30px;position:relative;border-bottom:1px solid var(--line)}
.rules li:before{content:"✓";position:absolute;left:4px;color:var(--red);font-weight:900}
.pcs{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px;margin-top:16px}
.pc{border:2px solid #111;background:#fff;display:flex;flex-direction:column}.pc img{width:100%;aspect-ratio:3/1;object-fit:cover;display:block;background:#111}
.pn{aspect-ratio:3/1;background:#111;color:#fff;display:flex;align-items:center;justify-content:center;font:italic 900 26px/1.1 Arial,sans-serif;text-transform:uppercase;padding:10px;text-align:center;border-bottom:4px solid var(--red)}
.pb{padding:14px}.pb small{color:var(--red);font-weight:900;text-transform:uppercase;letter-spacing:1px;font-size:12px}.pb h3{margin:4px 0 6px}.pb p{margin:0 0 12px}
.empty{background:#fff;border-left:6px solid var(--red);padding:16px 18px;margin-top:16px}
.join{background:#111;color:#ddd;padding:20px;margin-top:14px}.join input,.join textarea{display:block;width:100%;box-sizing:border-box;margin:0 0 10px;padding:12px;border:0;font:inherit;font-size:16px}
.join textarea{min-height:90px;resize:vertical}.join .chk{display:flex;gap:10px;align-items:flex-start;margin:6px 0 12px;color:#fff}.join .chk input{width:auto;margin:4px 0 0}
.join a{color:#ff6b72}.join p,.join .note{color:#ddd}
.btn{display:inline-block;background:var(--red);color:#fff;border:0;font:inherit;font-weight:900;padding:12px 18px;text-decoration:none;cursor:pointer;text-transform:uppercase;letter-spacing:.5px}.btn.k{background:#111}</style></head><body>${magHead("Partner-Netzwerk")}<main class="wrap">
<span class="ad">Partner-Kanäle · gegenseitige Empfehlung (Werbung)</span>
<p>Wir empfehlen Telegram-Kanäle, die ehrlich arbeiten – und sie empfehlen uns. So finden Leser seriöse Angebote, und gute Kanäle wachsen gemeinsam.</p>
<h2>Warum dieses Netzwerk wichtig ist</h2>
<div class="why"><div><h3>🚩 Viel Schein auf Telegram</h3><p>Viele Tipp-Kanäle zeigen nur ihre Treffer, löschen Verluste, posten bearbeitete Screenshots oder verkaufen angeblich „sichere“ Spiele. Für Leser ist kaum zu erkennen, wem man trauen kann.</p></div>
<div><h3>🧭 Orientierung für Leser</h3><p>Hier stehen nur Kanäle, die sich an feste, offene Regeln halten. Wer einen Kanal aus diesem Netzwerk findet, weiß, worauf er sich verlassen kann – und worauf nicht: auch gute Kanäle verlieren mal.</p></div>
<div><h3>🤝 Gemeinsam statt allein</h3><p>Ehrliche Kanäle wachsen langsamer als laute. Wenn sie sich gegenseitig empfehlen, erreichen sie mehr Leser – ohne gekaufte Anzeigen und ohne leere Versprechen.</p></div>
<div><h3>📊 Offenheit als Standard</h3><p>Wir zeigen jedes eigene Ergebnis auf unserer <a href="/ergebnisse">Ergebnisseite</a>, auch die Verluste. Genau diese Offenheit erwarten wir von jedem Partner.</p></div></div>
<h2>Unsere Regeln für Partner</h2><p>Jeder Partner …</p><ul class="rules">${PARTNER_RULES.map((r) => `<li>${r}</li>`).join("")}</ul>
<h2>Partner</h2>${cards ? `<div class="pcs">${cards}</div>` : `<div class="empty"><b>Das Netzwerk startet gerade.</b> Werde einer der ersten Partner – Anfrage unten.</div>`}
<p class="note">Wir prüfen Partner nach den Regeln oben, haben aber keinen Einfluss auf deren Inhalte und übernehmen dafür keine Verantwortung. Hinweise auf Verstöße bitte an <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a> – wir entfernen den Partner dann.</p>
<h2 id="mitmachen">Partner werden</h2>
<div class="join"><p style="margin:0 0 14px">Du betreibst einen Telegram-Kanal, der zu unseren Regeln passt? Schick uns eine Anfrage – wir melden uns auf Telegram. Dein Banner oder Logo (am besten quer, ca. 1200×400) schickst du uns danach dort.</p>
<form id="partner"><input id="p-name" placeholder="Dein Name" maxlength="100" autocomplete="name" required>
<input id="p-channel" placeholder="Kanal-Link, z. B. t.me/deinkanal" maxlength="100" autocapitalize="none" autocorrect="off" required>
<textarea id="p-text" placeholder="Worum geht es in deinem Kanal? (1–2 Sätze)" maxlength="300" required></textarea>
<input id="p-tg" placeholder="Dein Telegram-Name, z. B. @max_muster" maxlength="40" autocapitalize="none" autocorrect="off">
<input id="p-mail" type="email" placeholder="oder E-Mail (optional)" maxlength="150" autocomplete="email">
<label class="chk"><input type="checkbox" id="p-rules" required> Mein Kanal erfüllt die Regeln oben, und ich empfehle MoneyBag im Gegenzug in meinem Kanal.</label>
<label class="chk"><input type="checkbox" id="p-age" required> Ich bin mindestens 18 Jahre alt und betreibe den Kanal selbst.</label>
<button type="submit" class="btn">Anfrage senden</button>
<p id="p-out" class="note" style="margin:12px 0 0;color:#fff"></p></form>
<p class="note" style="margin:10px 0 0">Deine Angaben nutzen wir nur für diese Anfrage (<a href="/datenschutz">Datenschutz</a>). Lieber per E-Mail? <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p></div>
<script>
document.getElementById("partner").addEventListener("submit", async function (e) {
  e.preventDefault();
  var out = document.getElementById("p-out");
  if (!document.getElementById("p-rules").checked || !document.getElementById("p-age").checked) { out.textContent = "Bitte beide Häkchen setzen."; return; }
  out.textContent = "Sende …";
  try {
    var r = await fetch("/api/contact", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      kind: "partner", name: document.getElementById("p-name").value, channel: document.getElementById("p-channel").value,
      message: document.getElementById("p-text").value, telegram: document.getElementById("p-tg").value,
      email: document.getElementById("p-mail").value }) });
    var d = await r.json().catch(function () { return {}; });
    if (r.ok) { out.textContent = "✅ Danke! Wir schauen uns deinen Kanal an und melden uns."; e.target.reset(); }
    else out.textContent = d.error || "Senden fehlgeschlagen, bitte später erneut versuchen.";
  } catch (err) { out.textContent = "Keine Verbindung, bitte später erneut versuchen."; }
});
</script>
<div class="cta" style="background:#111;color:#fff;padding:20px;margin-top:30px">Unsere eigenen Zahlen, offen mit allen Verlusten: <a style="color:#ff6b72;font-weight:900" href="/ergebnisse">Ergebnisse</a> · <a style="color:#ff6b72;font-weight:900" href="/videos">Daten-Videos</a></div>
</main>${MAG_FOOT}</body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=600" } });
}

// "Daten der Woche" on the start page (since 2026-10-30): one own analysis per week from the InPlayFlux exports, refreshed
// with the weekly routine. Only numbers that hold in both halves of the period; script named in `source`.
const DATEN_DER_WOCHE = {
  date: "31.10.2026",
  title: "Spielstand nach einer Stunde – wann fällt noch ein Tor?",
  text: "Ein 0:0 nach 60 Minuten bleibt am häufigsten torlos. Wo schon Tore gefallen sind, fällt öfter noch eins – am häufigsten bei einer klaren Führung mit zwei oder mehr Toren Abstand.",
  bars: [["0:0", 70, 1443], ["Unentschieden mit Toren", 76, 2356], ["Führung mit 1 Tor", 74, 2551], ["Führung mit 2+ Toren", 77, 3821]],
  basis: "10.171 Spiele mit einer Szene um Minute 60 (55.–65.), 05.09.–31.10.2026, eigene Auswertung (scripts/margin_stats.py); jede Gruppe in beiden Hälften des Zeitraums ähnlich (z. B. 0:0: 72 % und 69 %, 2+ Tore: 77 % und 78 %).",
};

function landingPageHtml(rows, env, nowMs) {
  // Design 6 "Sport-Magazin" (owner's pick of six drafts, 26.10.; drafts in marketing/designs/): red/black/white,
  // diagonal shirt stripe, big headlines, live numbers and a 14-day chart drawn as inline SVG (no external resources).
  const all = summarize(rows);
  const d30 = summarize(rows.filter((r) => Date.parse(r.settledAt) >= nowMs - 30 * DAY_MS));
  const pct = (t) => (t.n ? (Math.round((t.won / t.n) * 1000) / 10).toString().replace(".", ",") + " %" : "–");
  const num = (label, t, sub) => `<div class="n"><b>${pct(t)}</b><span>${label}</span><small>${t.n ? `${t.won} von ${t.n} ${sub}` : "noch keine Daten"}</small></div>`;
  const free = String(freeChannel(env)).replace(/^@/, "");
  const freeLink = /^-?\d+$/.test(free) ? "https://t.me/MoneyBagAnalyst" : `https://t.me/${htmlEsc(free)}`;
  const mail = CONTACT_EMAIL;
  const updated = berlin(new Date(nowMs).toISOString(), { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  // Last 14 days: black = hit, red = lost (same day split as the results page).
  const dayKey = (iso) => berlin(iso, { year: "numeric", month: "2-digit", day: "2-digit" });
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const iso = new Date(nowMs - i * DAY_MS).toISOString();
    const list = rows.filter((r) => dayKey(r.settledAt) === dayKey(iso));
    days.push({ label: berlin(iso, { day: "2-digit", month: "2-digit" }), won: list.filter((r) => r.result === "won").length, lost: list.filter((r) => r.result === "lost").length });
  }
  const maxDay = Math.max(1, ...days.map((d) => d.won + d.lost));
  const W = 700, H = 200, gap = W / days.length, bw = gap * 0.62;
  const svgBars = days.map((d, i) => {
    const x = i * gap + (gap - bw) / 2, hw = (d.won / maxDay) * (H - 34), hl = (d.lost / maxDay) * (H - 34);
    return `<rect x="${x.toFixed(1)}" y="${(H - 22 - hw - hl).toFixed(1)}" width="${bw.toFixed(1)}" height="${hl.toFixed(1)}" fill="#e0262f"/>`
      + `<rect x="${x.toFixed(1)}" y="${(H - 22 - hw).toFixed(1)}" width="${bw.toFixed(1)}" height="${hw.toFixed(1)}" fill="#111"/>`
      + (i % 2 === 0 ? `<text x="${(x + bw / 2).toFixed(1)}" y="${H - 6}" font-size="12" text-anchor="middle" fill="#666">${d.label}</text>` : "");
  }).join("");
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MoneyBag – Live-Fußballsignale mit Datenmodell und offener Bilanz</title>${ICON_LINK}
<meta name="description" content="Live-Fußballsignale (Over Tore), bewertet von einem Datenmodell aus über 13.000 Live-Signalen. Mit Mindestquote, Einsatz in Einheiten und offener Ergebnisseite. Gratis-Kanal auf Telegram. 18+.">
<link rel="canonical" href="https://moneybag-signals.com/">${ogMeta("MoneyBag – Analysen statt Gefühl", "Live-Fußballsignale mit Datenmodell und offener Bilanz – Treffer wie Pleiten. Gratis-Kanal auf Telegram. 18+.", "/")}
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebSite","name":"MoneyBag","url":"https://moneybag-signals.com/","inLanguage":"de"},{"@type":"Organization","name":"MoneyBag","url":"https://moneybag-signals.com/","logo":"https://moneybag-signals.com/og.png","email":"${CONTACT_EMAIL}"}]}</script>
<style>
:root{--red:#e0262f;--ink:#111;--muted:#5d5d66;--line:#e4e4e8}
*{box-sizing:border-box}body{margin:0;background:#fff;color:var(--ink);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Liberation Sans",sans-serif}
a{color:var(--red)}.wrap{max-width:980px;margin:0 auto;padding:0 20px}
.hero{background:linear-gradient(115deg,#111 0 60%,var(--red) 60% 71%,#111 71%);color:#fff;padding:26px 0 54px}
${LOGO_CSS}
h1{font-size:64px;line-height:.98;margin:26px 0 16px;text-transform:uppercase;font-weight:900;max-width:640px;letter-spacing:-1px}h1 b{color:#ff4b52}
.lead{font-size:19px;color:#ddd;max-width:560px;margin:0}
.btn{display:inline-block;background:var(--red);color:#fff;font-weight:900;padding:15px 22px;margin:24px 10px 0 0;text-transform:uppercase;letter-spacing:1px;text-decoration:none;border:0;font-size:15px;cursor:pointer}
.btn.w{background:#fff;color:#111}.btn.k{background:#111;color:#fff}
.nums{display:flex;flex-wrap:wrap;border-bottom:5px solid var(--ink)}.n{flex:1 1 220px;padding:24px 20px;border-right:1px solid var(--line)}
.n b{display:block;font-size:46px;font-weight:900;color:var(--red);line-height:1}.n span{display:block;font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:1px;margin-top:6px}.n small{color:var(--muted)}
h2{font-size:15px;font-weight:900;text-transform:uppercase;letter-spacing:3px;margin:44px 0 14px;display:flex;align-items:center;gap:12px}
h2:before{content:"";width:28px;height:6px;background:var(--red);display:inline-block;transform:skewX(-20deg)}
.chart{border:2px solid var(--ink);padding:16px}.legend{font-size:13px;color:var(--muted);margin-top:6px}.legend i{display:inline-block;width:12px;height:12px;vertical-align:-1px;margin:0 4px 0 10px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}
.box{border-left:6px solid var(--red);background:#f6f6f7;padding:18px}.box h3{margin:0 0 6px;font-size:18px;font-weight:900}.box p{margin:0;color:#333}
.dw{border:2px solid var(--ink);padding:18px}.dw h3{margin:0 0 6px;font-size:22px;font-weight:900}.dw .t{margin:0 0 14px;color:#333}
.dw .r{display:grid;grid-template-columns:minmax(120px,190px) 1fr 52px;gap:10px;align-items:center;margin:8px 0;font-size:14px}
@media(max-width:600px){.dw .r{grid-template-columns:1fr 52px;gap:4px 10px}.dw .r>span:first-child{grid-column:1/-1}}
.dw .bar{height:18px;background:#eee}.dw .bar i{display:block;height:100%;background:var(--ink)}.dw .r.top .bar i{background:var(--red)}.dw .v{font-weight:900;text-align:right}
.price{background:#111;color:#fff;padding:22px;position:relative;overflow:hidden}.price:after{content:"";position:absolute;right:-40px;top:0;bottom:0;width:90px;background:var(--red);transform:skewX(-20deg)}
.price b{display:block;font-size:44px;font-weight:900;color:#ff4b52;line-height:1.1}.price p{color:#ccc;margin:8px 0 0;position:relative;z-index:1;max-width:85%}.price a{color:#fff}
.trial{background:#111;color:#fff;padding:24px}.trial p{color:#ccc}
#trial input:not([type=checkbox]){display:block;width:100%;background:#fff;color:#111;border:0;padding:14px;margin:0 0 10px;font:inherit}
.chk{display:flex;gap:8px;align-items:center;margin:4px 0 4px;color:#ccc}.trial .note{color:#aaa}.trial a{color:#ff6b72}.trial a.btn{color:#fff;margin-top:6px}
.note{color:var(--muted);font-size:14px}dt{font-weight:900;margin-top:16px}dd{margin:4px 0 0;color:#333}
footer{margin-top:48px;background:#111;color:#aaa;font-size:13px;padding:22px 0 30px}footer a{color:#ddd}
@media(max-width:600px){h1{font-size:42px}.lead{font-size:17px}.hero{background:linear-gradient(115deg,#111 0 72%,var(--red) 72% 82%,#111 82%)}.n{border-right:0;border-bottom:1px solid var(--line)}.n b{font-size:38px}}
</style></head><body>
<header class="hero"><div class="wrap">
${LOGO_HTML}
<h1>Analysen<br>statt <b>Gefühl.</b></h1>
<p class="lead">Live-Fußballsignale mit Datenmodell aus über 13.000 ausgewerteten Live-Signalen. Jedes Ergebnis wird automatisch veröffentlicht – Treffer wie Pleiten.</p>
<a class="btn" href="#test">🎁 24 h gratis testen</a><a class="btn w" href="/ergebnisse">📊 Alle Ergebnisse</a>
</div></header>
<section class="nums wrap">${num("🔥 High Confidence, gesamt", all.premium, "Signalen")}${num("Alle Stufen, 30 Tage", d30.all, "Signalen")}<div class="n"><b>20 €</b><span>pro Monat</span><small>monatlich kündbar</small></div></section>
<main class="wrap">
<h2>Die letzten 14 Tage</h2>
<div class="chart"><svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Treffer und verlorene Signale der letzten 14 Tage">${svgBars}</svg>
<div class="legend"><i style="background:#111;margin-left:0"></i>Treffer<i style="background:#e0262f"></i>verloren · Stand ${updated} · alle Stufen ${pct(all.all)} (${all.all.won} von ${all.all.n})</div></div>
<p class="note">Automatisch aus dem Live-Spielstand erfasst. Ungewertete Spiele zählen nicht mit. Vergangene Ergebnisse sagen nichts über künftige aus.</p>
<h2 id="daten">Daten der Woche</h2>
<div class="dw"><h3>${DATEN_DER_WOCHE.title}</h3><p class="t">${DATEN_DER_WOCHE.text}</p>
${DATEN_DER_WOCHE.bars.map(([l, v, n], i, a) => `<div class="r${i === a.length - 1 ? " top" : ""}"><span>${l} <small style="color:var(--muted)">(${n.toLocaleString("de-DE")})</small></span><div class="bar"><i style="width:${v}%"></i></div><span class="v">${v} %</span></div>`).join("")}
<p class="note" style="margin:12px 0 0">Stand ${DATEN_DER_WOCHE.date} · ${DATEN_DER_WOCHE.basis} Anteil der Spiele, in denen danach noch ein Tor fiel. · <a href="/videos">Alle Daten-Videos →</a></p></div>
<h2 id="so">So funktioniert MoneyBag</h2>
<div class="grid">
<div class="box"><h3>📐 Modell-Filter</h3><p>Nur Signale, die das Modell stark genug einschätzt, gehen raus. Jede Woche an neuen Spielen nachgeprüft – was nicht mehr trägt, wird abgeschaltet.</p></div>
<div class="box"><h3>💶 Mindestquote</h3><p>Bei jedem Signal steht, ab welcher Quote es sich auf Dauer rechnet. Liegt die Quote darunter: nicht setzen.</p></div>
<div class="box"><h3>📏 Einsatz in Einheiten</h3><p>0,5 bis 2 Einheiten je nach Stärke des Signals – nie mehr setzen, als man verlieren kann.</p></div>
<div class="box"><h3>📊 Offene Bilanz</h3><p>Jedes Ergebnis steht auf der <a href="/ergebnisse">Ergebnisseite</a>. Nichts gelöscht, nichts ausgewählt.</p></div>
</div>
<h2 id="preis">Gratis oder Premium</h2>
<div class="grid">
<div class="box"><h3>📢 Gratis-Kanal</h3><p>Täglich 3 abgeschlossene Signale mit Ergebnis und die Wochenbilanz auf Telegram.</p><a class="btn k" href="${freeLink}" style="margin-top:14px">Kanal öffnen</a></div>
<div class="price"><h3 style="margin:0 0 6px;position:relative;z-index:1">🔒 PREMIUM</h3><b style="position:relative;z-index:1">20 € / Monat</b><p><a href="#test">🎁 Erst 24 Stunden kostenlos testen</a></p><p>Alle Signale live im Premium-Kanal: 🔥 High Confidence, 🟠 Half-Risiko, 🧪 Over 1.5 (Testphase). Anfrage per E-Mail an <a href="mailto:${mail}">${mail}</a>. Zahlung per PayPal, monatlich kündbar.</p></div>
</div>
<h2 id="test">24 Stunden kostenlos testen</h2>
<div class="trial"><p style="margin:0 0 14px">Ein Tipp genügt: Unser Telegram-Bot schickt dir <b style="color:#fff">sofort</b> deine Einladung in den Premium-Kanal und den Link zum Analyse-Tool – rund um die Uhr. Nach 24 Stunden endet der Test automatisch, kein Abo, keine Zahlungsdaten.</p>
<label class="chk"><input type="checkbox" id="t-age"> Ich bin mindestens 18 Jahre alt.</label>
<a class="btn" id="t-go" href="/test-starten" rel="nofollow">🎁 Test auf Telegram starten</a>
<p id="t-out" class="note" style="margin:12px 0 0"></p>
<p class="note" style="margin:10px 0 0">Ein Test pro Person. Dafür speichern wir deine Telegram-Nutzer-ID (<a href="/datenschutz">Datenschutz</a>). Kein Telegram? Schreib uns: <a href="mailto:${mail}">${mail}</a></p></div>
<script>
document.getElementById("t-go").addEventListener("click", function (e) {
  if (!document.getElementById("t-age").checked) { e.preventDefault(); document.getElementById("t-out").textContent = "Bitte bestätige zuerst, dass du mindestens 18 bist."; }
});
</script>
<h2 id="faq">Häufige Fragen</h2>
<dl>
<dt>Kann ich Premium erst testen?</dt><dd>Ja, 24 Stunden kostenlos. Einfach <a href="#test">oben anfragen</a> – du bekommst den Testzugang auf Telegram. Er endet automatisch – kein Abo, keine Kündigung nötig.</dd>
<dt>Wie viele Signale gibt es?</dt><dd>Je nach Spieltag mehrere pro Tag, am Wochenende mehr.</dd>
<dt>Muss ich jedes Signal setzen?</dt><dd>Nein. Nur wenn die Quote über der angegebenen Mindestquote liegt.</dd>
<dt>Was ist eine Einheit?</dt><dd>Ein fester Betrag, den du selbst festlegst, z. B. 1–2 % deines Budgets.</dd>
<dt>Gibt es eine Garantie?</dt><dd>Nein. Sportwetten bleiben ein Risiko, auch mit Daten. Darum zeigen wir jedes Ergebnis offen.</dd>
<dt>Ich habe einen Zugangslink.</dt><dd>Öffne ihn einfach direkt – er führt dich zu deinem Zugang.</dd>
</dl>
</main>
<footer><div class="wrap">18+ · Sportwetten bergen Verlustrisiken · Keine Gewinngarantie. MoneyBag ist kein Wettanbieter und vermittelt keine Wetten.<br>Hilfe bei Glücksspielproblemen: <a href="https://www.check-dein-spiel.de">check-dein-spiel.de</a> · BZgA-Hotline 0800 1 37 27 00<br><a href="/ergebnisse">Ergebnisse</a> · <a href="/videos">Videos</a> · <a href="/partner">Partner</a>${env.IMPRESSUM_NAME && env.IMPRESSUM_ADDRESS ? ' · <a href="/impressum">Impressum</a> · <a href="/agb">AGB</a> · <a href="/widerruf">Widerrufsbelehrung</a> · <a href="/datenschutz">Datenschutz</a>' : ""}</div></footer>
</body></html>`;
}

// AGB, withdrawal policy and privacy policy (owner chose Kleinunternehmer § 19 UStG and PayPal, 25.10.). Name and address come from
// the same Cloudflare variables as the Impressum; without them both pages are 404.
function legalPage(env, kind) {
  if (!env.IMPRESSUM_NAME || !env.IMPRESSUM_ADDRESS) return new Response("Not found", { status: 404 });
  const name = htmlEsc(env.IMPRESSUM_NAME);
  const addr = String(env.IMPRESSUM_ADDRESS).split("|").map((l) => htmlEsc(l.trim())).join(", ");
  const email = htmlEsc(env.IMPRESSUM_EMAIL || CONTACT_EMAIL);
  const who = `${name}, ${addr}, E-Mail: <a href="mailto:${email}">${email}</a>`;
  const agb = `<h1>Allgemeine Geschäftsbedingungen</h1><p class="note">MoneyBag Premium · Stand: 25.10.2026</p>
<h2>§ 1 Geltungsbereich, Anbieter</h2><p>(1) Diese AGB gelten für alle Verträge über den Premium-Zugang „MoneyBag Premium“ zwischen ${who} (im Folgenden „Anbieter“) und den Kunden.<br>(2) Abweichende Bedingungen des Kunden gelten nicht.</p>
<h2>§ 2 Leistung</h2><p>(1) Der Anbieter gewährt für die Vertragslaufzeit Zugang zu einem privaten Telegram-Kanal, in dem statistische Einschätzungen zu laufenden Fußballspielen („Signale“) veröffentlicht werden.<br>(2) Die Signale sind unverbindliche Informationen auf Grundlage statistischer Auswertungen. Der Anbieter ist <b>kein Wettanbieter</b>, nimmt keine Wetten an und vermittelt keine Wetten. Ob und wie der Kunde wettet, entscheidet er allein und auf eigenes Risiko.<br>(3) Es besteht <b>keine Gewinngarantie</b>. Vergangene Ergebnisse (veröffentlicht auf <a href="/ergebnisse">moneybag-signals.com/ergebnisse</a>) sagen nichts über künftige Ergebnisse aus.<br>(4) Die Anzahl der Signale hängt vom Spielplan ab und schwankt; ein Anspruch auf eine Mindestzahl besteht nicht.<br>(5) Der Dienst nutzt Telegram und externe Datenquellen. Kurzzeitige Ausfälle, die der Anbieter nicht zu vertreten hat, begründen keinen Anspruch auf Preisminderung. Fällt der Dienst länger als 3 zusammenhängende Tage aus, wird die Laufzeit entsprechend verlängert.</p>
<h2>§ 3 Voraussetzungen</h2><p>Der Kunde muss mindestens <b>18 Jahre</b> alt sein und ein Telegram-Konto besitzen. Mit der Bestellung bestätigt der Kunde, volljährig zu sein.</p>
<h2>§ 4 Vertragsschluss</h2><p>(1) Die Darstellung des Angebots auf der Website und in Telegram ist kein verbindliches Angebot.<br>(2) Der Kunde fragt den Zugang per E-Mail an ${email} an. Der Anbieter antwortet mit den Zahlungsdaten und diesen AGB (verbindliches Angebot). Der Vertrag kommt zustande, wenn der Kunde das Angebot per E-Mail annimmt oder bezahlt.<br>(3) Nach Zahlungseingang erhält der Kunde einen persönlichen Einladungslink. Vertragssprache ist Deutsch.<br>(4) Auf Anfrage erhält der Kunde einmalig einen kostenlosen Testzugang für 24 Stunden. Er endet automatisch, verlängert sich nicht und begründet keine Zahlungspflicht.</p>
<h2>§ 5 Preis und Zahlung</h2><p>(1) Der Preis beträgt <b>20 € pro Monat</b>. Gemäß § 19 UStG wird keine Umsatzsteuer berechnet (Kleinunternehmer).<br>(2) Die Zahlung erfolgt monatlich im Voraus per PayPal.</p>
<h2>§ 6 Laufzeit und Kündigung</h2><p>(1) Der Vertrag läuft einen Monat und verlängert sich jeweils um einen weiteren Monat, wenn er nicht gekündigt wird.<br>(2) Beide Seiten können <b>jederzeit zum Ende des laufenden Monats</b> kündigen. Eine Kündigung per E-Mail an ${email} genügt.<br>(3) Das Recht zur fristlosen Kündigung aus wichtigem Grund bleibt unberührt. Ein wichtiger Grund für den Anbieter liegt insbesondere vor, wenn der Kunde gegen § 7 verstößt.</p>
<h2>§ 7 Pflichten des Kunden</h2><p>Der Zugang ist persönlich. Der Kunde darf Einladungslinks, Signale oder Inhalte des Premium-Kanals <b>nicht weitergeben, weiterverkaufen oder veröffentlichen</b>, auch nicht in Auszügen oder als Screenshot.</p>
<h2>§ 8 Haftung</h2><p>(1) Der Anbieter haftet unbeschränkt bei Vorsatz und grober Fahrlässigkeit, bei Verletzung von Leben, Körper oder Gesundheit sowie nach dem Produkthaftungsgesetz.<br>(2) Bei leichter Fahrlässigkeit haftet der Anbieter nur bei Verletzung einer wesentlichen Vertragspflicht (Kardinalpflicht), begrenzt auf den vorhersehbaren, vertragstypischen Schaden.<br>(3) Für Verluste aus Wetten, die der Kunde auf Grundlage der Signale abschließt, haftet der Anbieter nicht; der Kunde entscheidet über jede Wette selbst (§ 2 Abs. 2).</p>
<h2>§ 9 Verantwortungsvolles Spielen</h2><p>Wetten kann süchtig machen. Setze nur Geld, dessen Verlust du verkraften kannst. Hilfe: <a href="https://www.check-dein-spiel.de">check-dein-spiel.de</a>, BZgA-Hotline 0800 1 37 27 00.</p>
<h2>§ 10 Widerrufsrecht</h2><p>Verbrauchern steht ein Widerrufsrecht nach der <a href="/widerruf">Widerrufsbelehrung</a> zu.</p>
<h2>§ 11 Streitbeilegung, Schlussbestimmungen</h2><p>(1) Der Anbieter ist nicht bereit und nicht verpflichtet, an Streitbeilegungsverfahren vor einer Verbraucherschlichtungsstelle teilzunehmen.<br>(2) Es gilt deutsches Recht. Gegenüber Verbrauchern gilt diese Rechtswahl nur, soweit dadurch nicht zwingende Verbraucherschutzvorschriften des Staates entzogen werden, in dem der Verbraucher seinen gewöhnlichen Aufenthalt hat.<br>(3) Sind einzelne Bestimmungen unwirksam, bleibt der Vertrag im Übrigen wirksam.</p>`;
  const widerruf = `<h1>Widerrufsbelehrung</h1>
<h2>Widerrufsrecht</h2><p>Sie haben das Recht, binnen vierzehn Tagen ohne Angabe von Gründen diesen Vertrag zu widerrufen.</p><p>Die Widerrufsfrist beträgt vierzehn Tage ab dem Tag des Vertragsabschlusses.</p>
<p>Um Ihr Widerrufsrecht auszuüben, müssen Sie uns (${who}) mittels einer eindeutigen Erklärung (z. B. ein mit der Post versandter Brief oder eine E-Mail) über Ihren Entschluss, diesen Vertrag zu widerrufen, informieren. Sie können dafür das unten stehende Muster-Widerrufsformular verwenden, das jedoch nicht vorgeschrieben ist.</p>
<p>Zur Wahrung der Widerrufsfrist reicht es aus, dass Sie die Mitteilung über die Ausübung des Widerrufsrechts vor Ablauf der Widerrufsfrist absenden.</p>
<h2>Folgen des Widerrufs</h2><p>Wenn Sie diesen Vertrag widerrufen, haben wir Ihnen alle Zahlungen, die wir von Ihnen erhalten haben, unverzüglich und spätestens binnen vierzehn Tagen ab dem Tag zurückzuzahlen, an dem die Mitteilung über Ihren Widerruf dieses Vertrags bei uns eingegangen ist. Für diese Rückzahlung verwenden wir dasselbe Zahlungsmittel, das Sie bei der ursprünglichen Transaktion eingesetzt haben, es sei denn, mit Ihnen wurde ausdrücklich etwas anderes vereinbart; in keinem Fall werden Ihnen wegen dieser Rückzahlung Entgelte berechnet.</p>
<p>Haben Sie verlangt, dass die Dienstleistungen während der Widerrufsfrist beginnen sollen, so haben Sie uns einen angemessenen Betrag zu zahlen, der dem Anteil der bis zu dem Zeitpunkt, zu dem Sie uns von der Ausübung des Widerrufsrechts hinsichtlich dieses Vertrags unterrichten, bereits erbrachten Dienstleistungen im Vergleich zum Gesamtumfang der im Vertrag vorgesehenen Dienstleistungen entspricht.</p>
<h2>Muster-Widerrufsformular</h2><p>(Wenn Sie den Vertrag widerrufen wollen, dann füllen Sie bitte dieses Formular aus und senden Sie es zurück.)</p>
<p>– An ${who}:<br>– Hiermit widerrufe(n) ich/wir (*) den von mir/uns (*) abgeschlossenen Vertrag über die Erbringung der folgenden Dienstleistung: MoneyBag Premium<br>– Bestellt am (*) / erhalten am (*)<br>– Name des/der Verbraucher(s)<br>– Anschrift des/der Verbraucher(s)<br>– Unterschrift des/der Verbraucher(s) (nur bei Mitteilung auf Papier)<br>– Datum</p><p class="note">(*) Unzutreffendes streichen.</p>`;
  const datenschutz = `<h1>Datenschutzerklärung</h1><p class="note">Stand: 25.10.2026</p>
<h2>1. Verantwortlicher</h2><p>${who}</p>
<h2>2. Das Wichtigste in Kürze</h2><p>Diese Website verwendet <b>keine Analyse- oder Tracking-Tools, keine Werbung und keine Social-Media-Plugins</b>. Es wird nur ein technisch notwendiges Cookie für Premium-Kunden gesetzt. Daten werden nur verarbeitet, soweit es für den Betrieb der Website, die Beantwortung von Anfragen und die Abwicklung des Premium-Abos nötig ist.</p>
<h2>3. Hosting und Server-Logdaten</h2><p>Die Website läuft bei Cloudflare, Inc., 101 Townsend St., San Francisco, CA 94107, USA. Beim Aufruf jeder Seite verarbeitet Cloudflare technisch notwendige Daten: IP-Adresse, Datum und Uhrzeit, aufgerufene Adresse, Browser- und Gerätetyp. Das dient der Auslieferung der Seiten, der Sicherheit (z. B. Schutz vor Angriffen) und der Fehlersuche. Protokolle werden nur für wenige Tage gespeichert. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO (berechtigtes Interesse an einem sicheren, funktionierenden Angebot). Cloudflare ist unter dem EU-US Data Privacy Framework zertifiziert (Angemessenheitsbeschluss der EU-Kommission, Art. 45 DSGVO). Mehr: <a href="https://www.cloudflare.com/de-de/privacypolicy/">cloudflare.com/privacypolicy</a>.</p>
<h2>4. Cookie und lokaler Speicher</h2><p>Öffnet ein Premium-Kunde seinen persönlichen Zugangslink, wird das Cookie <b>mb_access</b> gesetzt. Es enthält nur den Zugangscode und läuft ab, wenn der Zugang endet. Ohne dieses Cookie funktioniert der Zugang nicht; es ist technisch notwendig (§ 25 Abs. 2 Nr. 2 TDDDG, Art. 6 Abs. 1 lit. b DSGVO). Im Premium-Tool werden Einstellungen und der Verlauf nur im lokalen Speicher deines Browsers abgelegt und nicht an uns übertragen. Auf der Startseite, der Ergebnisseite und den Rechtstexten werden keine Cookies gesetzt.</p>
<h2>5. Kontaktformular und E-Mail</h2><p>Wenn du uns über das Kontaktformular schreibst, verarbeiten wir Name, E-Mail-Adresse und Nachricht, um deine Anfrage zu beantworten. Den 24-Stunden-Test startest du über unseren Telegram-Bot: Wir speichern dann deine Telegram-Nutzer-ID, deinen Nutzernamen und den Zeitpunkt, erstellen einen persönlichen Einladungslink in den Premium-Kanal und entfernen dich nach 24 Stunden automatisch wieder aus dem Kanal; die Nutzer-ID bewahren wir ein Jahr auf, damit jede Person nur einmal testet (Art. 6 Abs. 1 lit. b und f DSGVO). Beim Formular „Partner werden“ (Seite /partner) sind es Name, Link und Beschreibung deines Kanals, Telegram-Name und/oder E-Mail-Adresse sowie deine Bestätigungen; ein Banner, das du uns danach schickst, zeigen wir nur nach deiner Zustimmung auf der Partner-Seite. Die Anfrage wird uns über den Messenger Telegram zugestellt (siehe Nr. 7). Zum Schutz vor Missbrauch wird deine IP-Adresse für 60 Sekunden gespeichert und danach automatisch gelöscht. Schreibst du uns eine E-Mail, verarbeiten wir deine Adresse und den Inhalt; Mails an ${email} werden über Cloudflare (Email Routing) an unser Postfach bei GMX (1&amp;1 Mail &amp; Media GmbH) weitergeleitet. Rechtsgrundlage ist Art. 6 Abs. 1 lit. b DSGVO (Anfragen zu einem Vertrag) bzw. lit. f DSGVO (sonstige Anfragen). Wir löschen die Daten, wenn die Anfrage erledigt ist und keine Aufbewahrungspflicht besteht.</p>
<h2>6. Premium-Abo und Zahlung</h2><p>Für das Abo verarbeiten wir deinen Namen, deine E-Mail-Adresse, ggf. deinen Telegram-Namen sowie Zahlungsdaten (Art. 6 Abs. 1 lit. b DSGVO). Die Zahlung erfolgt über PayPal (PayPal (Europe) S.à r.l. et Cie, S.C.A., 22–24 Boulevard Royal, L-2449 Luxemburg); dabei gelten auch die Datenschutzhinweise von PayPal: <a href="https://www.paypal.com/de/legalhub/privacy-full">paypal.com/de/legalhub/privacy-full</a>. Rechnungs- und Zahlungsbelege bewahren wir nach den gesetzlichen Fristen (bis zu 10 Jahre, § 147 AO, § 257 HGB) auf (Art. 6 Abs. 1 lit. c DSGVO).</p>
<h2>7. Telegram</h2><p>Unsere Kanäle (Gratis- und Premium-Kanal) und unser Bot laufen über den Messenger-Dienst Telegram. Wenn du einem Kanal beitrittst, verarbeitet Telegram deine Daten nach eigenen Bestimmungen: <a href="https://telegram.org/privacy">telegram.org/privacy</a>. Wir sehen dabei nur, was Telegram uns anzeigt (z. B. Profilname und Nutzername von Kanalmitgliedern) und nutzen das nur zur Verwaltung des Zugangs (Art. 6 Abs. 1 lit. b DSGVO). Telegram kann Daten außerhalb der EU verarbeiten.</p>
<h2>8. Quoten-Abfrage im Premium-Tool (optional)</h2><p>Im Premium-Tool kannst du freiwillig einen eigenen Schlüssel für „The Odds API“ eintragen. Nur dann ruft dein Browser Quoten direkt bei diesem Anbieter ab; dabei werden deine IP-Adresse und dein Schlüssel an ihn übermittelt (Art. 6 Abs. 1 lit. a DSGVO, durch dein Eintragen). Ohne Schlüssel findet keine Verbindung statt.</p>
<h2>9. Deine Rechte</h2><p>Du hast das Recht auf Auskunft (Art. 15 DSGVO), Berichtigung (Art. 16), Löschung (Art. 17), Einschränkung der Verarbeitung (Art. 18), Datenübertragbarkeit (Art. 20) und Widerspruch gegen Verarbeitungen auf Grundlage berechtigter Interessen (Art. 21). Eine Einwilligung kannst du jederzeit mit Wirkung für die Zukunft widerrufen. Schreib dazu einfach an ${email}. Außerdem kannst du dich bei einer Datenschutz-Aufsichtsbehörde beschweren, z. B. beim Bayerischen Landesamt für Datenschutzaufsicht (BayLDA), Promenade 18, 91522 Ansbach.</p>
<h2>10. Sonstiges</h2><p>Eine automatisierte Entscheidungsfindung oder ein Profiling findet nicht statt. Alle Seiten werden verschlüsselt (HTTPS) übertragen. Wir passen diese Erklärung an, wenn sich das Angebot oder die Rechtslage ändert.</p>`;
  const title = { agb: "AGB", widerruf: "Widerrufsbelehrung", datenschutz: "Datenschutzerklärung" }[kind];
  const html = `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MoneyBag – ${title}</title>${ICON_LINK}<meta name="robots" content="noindex">
<style>${MAG_CSS}</style></head><body>${magHead(title)}<main class="wrap">
${{ agb, widerruf, datenschutz }[kind]}
</main>${MAG_FOOT}</body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS } });
}

async function landingPage(request, env, ctx) {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = new Request(new URL("/__start", request.url).toString());
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }
  const res = new Response(landingPageHtml(await listResults(env), env, Date.now()), {
    headers: { "content-type": "text/html; charset=utf-8", "Cache-Control": `public, max-age=${RESULTS_CACHE_S}`, ...SECURITY_HEADERS },
  });
  if (cache) {
    const put = cache.put(cacheKey, res.clone());
    if (ctx && ctx.waitUntil) ctx.waitUntil(put);
    else await put;
  }
  return res;
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
<title>MoneyBag – Zugang</title>${ICON_LINK}
<style>${MAG_CSS}
  .box{border-left:6px solid var(--red);background:#f6f6f7;padding:18px;margin-top:16px}
  input,textarea{width:100%;background:#fff;color:#111;border:1px solid #d4d4da;padding:12px;margin-bottom:10px;font:inherit}
  textarea{resize:vertical;min-height:70px}
  button{background:var(--red);color:#fff;border:0;padding:14px 20px;font-weight:900;text-transform:uppercase;letter-spacing:1px;cursor:pointer;font-size:15px}
  button:disabled{opacity:.6;cursor:default}
  .status{margin-top:10px;font-size:.9rem}.status.ok{color:#14853b}.status.err{color:var(--red)}
  label{display:block;font-size:.8rem;color:var(--muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:1px;font-weight:700}</style></head>
<body>${magHead("Zugang erforderlich")}<main class="wrap">
  <p style="margin-top:22px;font-weight:700">${message}</p>
  <p>Noch kein Zugang? <a href="/">Zur Startseite</a> – dort kannst du Premium 24 Stunden kostenlos testen.</p>
  <div class="box">
    <p><strong>Weiter nutzen?</strong><br>
    Am schnellsten geht's direkt über Telegram — oder per Formular, wenn du kein Telegram nutzt.</p>
    <a href="https://t.me/harzpassage_bot" target="_blank" rel="noopener" style="display:block;text-align:center;background:#111;color:#fff;text-decoration:none;font-weight:900;padding:14px 16px;margin-bottom:16px;text-transform:uppercase;letter-spacing:1px">💬 Direkt über Telegram schreiben</a>
    <p style="text-align:center;color:#5d5d66;font-size:.85rem;margin:-8px 0 16px">— oder —</p>
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
</main>${MAG_FOOT}</body></html>`, 403);
}

async function handleAdminPage() {
  return htmlResponse(`<!DOCTYPE html>
<html lang="de"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Zugangsverwaltung</title>${ICON_LINK}
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
  <button id="test-o15-btn" style="background:#2c3444;color:#e6e9f0;margin-bottom:8px;">Test Over 1.5 senden</button>
  <div class="out" id="test-o15-out" style="margin-bottom:10px;"></div>
  <button id="af-btn" style="background:#2c3444;color:#e6e9f0;margin-bottom:8px;">API-Football prüfen</button>
  <div class="out" id="af-out" style="margin-bottom:10px;"></div>
  <button id="odds-btn" style="background:#2c3444;color:#e6e9f0;margin-bottom:8px;">Quoten-Abdeckung prüfen</button>
  <button id="matches-btn" style="background:#2c3444;color:#e6e9f0;margin:0 0 8px 6px;">Spiele-Archiv CSV (7 Tage)</button>
  <div class="out" id="odds-out" style="margin-bottom:10px;"></div>
  <button id="img-btn" style="margin-bottom:8px;">Bilanz-Grafik erstellen (7 Tage)</button>
  <div class="out" id="img-out" style="margin-bottom:10px;"></div>
  <button id="res7-btn">Letzte 7 Tage</button>
  <button id="res30-btn" style="margin-left:6px;">Letzte 30 Tage</button>
  <button id="res-csv-btn" style="margin-left:6px;">CSV speichern (30 Tage)</button>
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
// Every admin call: clear German hint when the password field is empty or wrong (was a bare "unauthorized").
const _fetch = window.fetch.bind(window);
window.fetch = async (u, o) => {
  if (String(u).startsWith('/admin/api/') && !pw()) throw new Error('Bitte oben zuerst das Admin-Passwort eintragen (das Feld ist nach dem Neuladen der Seite leer).');
  const r = await _fetch(u, o);
  if (r.status === 401 && String(u).startsWith('/admin/api/')) throw new Error('Passwort falsch – bitte oben im Passwortfeld prüfen und erneut tippen.');
  return r;
};
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
  // Design 6 "Sport-Magazin" like the public pages (since 31.10.): black top with a red diagonal stripe, speed logo,
  // black = hit / red = lost bars as on /ergebnisse, black footer with the results link and 18+ line.
  const W = 1080, H = 1350, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const font = (w, px, it) => (it ? 'italic ' : '') + w + ' ' + px + 'px Arial, Helvetica, -apple-system, sans-serif';
  const red = '#e0262f', red2 = '#ff4b52', ink = '#111111', muted = '#5d5d66', line = '#e4e4e8';
  const d2 = d => String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0') + '.';
  const pct = t => t.n ? Math.round(t.won / t.n * 1000) / 10 : null;
  const de = v => String(v).replace('.', ',');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);
  // black hero with the diagonal shirt stripe
  const HB = 620;
  g.fillStyle = ink; g.fillRect(0, 0, W, HB);
  g.fillStyle = red; g.beginPath(); g.moveTo(760, 0); g.lineTo(930, 0); g.lineTo(640, HB); g.lineTo(470, HB); g.closePath(); g.fill();
  g.fillStyle = ink; g.globalAlpha = 0.55; g.fillRect(0, 0, W, HB); g.globalAlpha = 1;
  g.fillStyle = red; g.beginPath(); g.moveTo(860, 0); g.lineTo(1010, 0); g.lineTo(720, HB); g.lineTo(570, HB); g.closePath(); g.fill();
  // speed logo
  g.fillStyle = red2; g.fillRect(96, 92, 64, 8); g.fillRect(80, 110, 80, 8); g.fillRect(104, 128, 56, 8);
  g.textAlign = 'left'; g.font = font('900', 54, true);
  g.fillStyle = '#ffffff'; g.fillText('MONEY', 172, 136);
  const mw = g.measureText('MONEY').width;
  g.fillStyle = red2; g.fillText('BAG', 172 + mw, 136);
  g.fillStyle = '#ffffff'; g.font = font('900', 104, true); g.fillText('WOCHENBILANZ', 76, 270);
  g.fillStyle = '#cccccc'; g.font = font('700', 38);
  g.fillText('KW ' + isoWeek(to) + ' · ' + d2(from) + '–' + d2(to) + to.getFullYear(), 80, 330);
  const total = pct(s.all);
  g.fillStyle = '#ffffff'; g.font = font('900', 190, true);
  g.fillText(total == null ? '–' : de(total) + ' %', 70, 520);
  g.fillStyle = '#dddddd'; g.font = font('700', 40);
  g.fillText(s.all.n ? s.all.won + ' von ' + s.all.n + ' Tipps getroffen' : 'Noch keine abgeschlossenen Tipps', 80, 582);
  // section head like the h2 on the pages
  g.fillStyle = red; g.beginPath(); g.moveTo(86, 680); g.lineTo(130, 680); g.lineTo(124, 692); g.lineTo(80, 692); g.closePath(); g.fill();
  g.fillStyle = ink; g.font = font('900', 30); g.fillText('NACH STUFE', 146, 696);
  const rows = [
    ['🔥', 'High Confidence', s.premium], ['🟠', 'Half-Risiko', s.half || { n: 0, won: 0 }],
    ['⚠️', 'Risiko', s.risk, 'seit 13.10. abgeschaltet'], ['🛡️', 'Under 3.5', s.under || { n: 0, won: 0 }],
    ['🧪', 'Over 1.5 Test', s.o15 || { n: 0, won: 0 }, 'seit 21.10.'],
  ].filter(r => r[2] && r[2].n);
  let y = 790;
  rows.forEach(([icon, label, t, note]) => {
    const p = pct(t);
    g.textAlign = 'left'; g.fillStyle = ink; g.font = font('900', 44); g.fillText(icon + '  ' + label, 80, y);
    if (note) {
      const x = 80 + g.measureText(icon + '  ' + label).width + 18;
      g.fillStyle = muted; g.font = font('700', 28); g.fillText(note, x, y);
    }
    g.textAlign = 'right'; g.fillStyle = red; g.font = font('900', 46, true); g.fillText(de(p) + ' %', 1000, y);
    const pw2 = g.measureText(de(p) + ' %').width;
    g.fillStyle = muted; g.font = font('700', 32); g.fillText(t.won + '/' + t.n, 1000 - pw2 - 30, y);
    g.textAlign = 'left';
    g.fillStyle = red; g.fillRect(80, y + 22, 920, 22);
    g.fillStyle = ink; g.fillRect(80, y + 22, 920 * p / 100, 22);
    y += 120;
  });
  g.fillStyle = muted; g.font = font('700', 26);
  g.fillText('Schwarz = Treffer, Rot = verloren', 80, y - 30);
  if (s.priced >= 20) {
    const roi = s.staked ? Math.round(s.profit / s.staked * 1000) / 10 : 0;
    const sign = s.profit >= 0 ? '+' : '';
    g.fillStyle = s.profit >= 0 ? ink : red; g.font = font('900', 40);
    g.fillText('💶 ' + sign + de(s.profit) + ' Einheiten (Rendite ' + sign + de(roi) + ' %)', 80, y + 30);
    g.fillStyle = muted; g.font = font('700', 28);
    g.fillText('bei ' + s.priced + (s.priced === 1 ? ' Tipp' : ' Tipps') + ' mit Quote ab Mindestquote', 80, y + 72);
  }
  // footer
  g.fillStyle = ink; g.fillRect(0, 1190, W, H - 1190);
  g.fillStyle = red; g.fillRect(0, 1190, W, 8);
  g.fillStyle = '#ffffff'; g.font = font('900', 34);
  g.fillText('Alle Ergebnisse: moneybag-signals.com/ergebnisse', 80, 1256);
  g.fillStyle = '#aaaaaa'; g.font = font('700', 26);
  g.fillText('Automatisch aus dem Live-Spielstand erfasst – Treffer und Verluste.', 80, 1298);
  g.fillText('18+ · Keine Gewinngarantie · Hilfe: check-dein-spiel.de', 80, 1332);
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
    const canvas = drawBilanz(d.summary, from, to);
    const url = canvas.toDataURL('image/png');
    const name = 'moneybag_bilanz_' + to.toISOString().slice(0, 10) + '.png';
    out.innerHTML = '<button id="img-send-btn" style="margin-bottom:8px;">An Gratis-Kanal senden</button><div class="out" id="img-send-out"></div>' +
      '<div style="font-size:0.8rem;color:#8891a3;margin-bottom:6px;">Auf dem iPad: Bild lange gedrückt halten → „Zu Fotos hinzufügen“. Oder <a href="' + url + '" download="' + name + '" style="color:#d4a72c;">herunterladen</a>.</div>' +
      '<img src="' + url + '" style="width:100%;border-radius:6px;">';
    let armed = false;
    document.getElementById('img-send-btn').addEventListener('click', () => {
      const btn = document.getElementById('img-send-btn');
      const so = document.getElementById('img-send-out');
      if (!armed) {
        armed = true;
        btn.textContent = 'Wirklich senden? Nochmal tippen';
        so.textContent = 'Das Bild geht an alle Abonnenten des Gratis-Kanals.';
        setTimeout(() => { armed = false; btn.textContent = 'An Gratis-Kanal senden'; }, 8000);
        return;
      }
      armed = false;
      btn.disabled = true;
      so.textContent = 'Sende …';
      canvas.toBlob(async (blob) => {
        try {
          const r = await fetch('/admin/api/post-bilanz', { method: 'POST', headers: { 'Authorization': 'Bearer ' + pw(), 'Content-Type': 'image/png' }, body: blob });
          const res = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(res.error || ('Fehler ' + r.status));
          so.textContent = res.sent ? '✅ Im Gratis-Kanal gepostet.' : '❌ Telegram hat nicht angenommen.';
        } catch (e) { so.textContent = e.message; btn.disabled = false; }
      }, 'image/png');
    });
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
    const mk = Object.entries(s.market || {}).filter(e => e[1]);
    if (mk.length) {
      const nm = { premium: 'High Confidence', half: 'Half-Risiko', o15: 'Over 1.5 Test', under: 'Under 3.5' };
      html += '<br><b>Markt-Vergleich</b> (Markt-Erwartung beim Signal vs. getroffen):';
      mk.forEach(([k, v]) => {
        const hit = Math.round(v.won / v.n * 1000) / 10;
        const diff = Math.round((hit - v.expected) * 10) / 10;
        html += '<br>' + nm[k] + ': Markt ' + v.expected + ' % · wir ' + hit + ' % (' + v.won + '/' + v.n + ') · <b style="color:' + (diff > 0 ? '#4caf7a' : '#e06c5a') + ';">' + (diff > 0 ? '+' : '') + diff + ' Punkte</b>' + (v.n < 50 ? ' <small>(noch wenig Daten)</small>' : '');
      });
    }
    if (s.waitBets) html += '<br>Warten bis Quote 1,40 (geschätzt): ' + s.waitWon + ' von ' + s.waitBets + ' gesetzten getroffen, ' + s.waitSkipped + ' Tore kamen vorher · <b>' + (s.waitProfit >= 0 ? '+' : '') + s.waitProfit + ' Einheiten</b>';
    if (s.quotedAll) html += '<br>Jeder Tipp zur Quote beim Signal (' + s.quotedAll + ' Tipps, Ø Quote ' + s.avgQuote + '): <b>' + (s.profitAll >= 0 ? '+' : '') + s.profitAll + ' Einheiten</b>';
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

let o15Armed = false;
document.getElementById('test-o15-btn').addEventListener('click', async () => {
  const out = document.getElementById('test-o15-out');
  const btn = document.getElementById('test-o15-btn');
  if (!o15Armed) {
    o15Armed = true;
    btn.textContent = 'Wirklich senden? Nochmal tippen';
    out.textContent = 'Der Test-Post geht an alle Abonnenten (deutlich als TEST markiert).';
    setTimeout(() => { o15Armed = false; btn.textContent = 'Test Over 1.5 senden'; }, 8000);
    return;
  }
  o15Armed = false;
  btn.textContent = 'Test Over 1.5 senden';
  out.textContent = 'Sende …';
  try {
    const r = await fetch('/admin/api/test-post?tier=o15', { method: 'POST', headers: { 'Authorization': 'Bearer ' + pw() } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || ('Fehler ' + r.status + ' (falsches Passwort?)'));
    out.textContent = (d.sent ? '✅ Gesendet. ' : '❌ Telegram hat nicht angenommen. ') +
      (d.match ? 'Beispiel: ' + d.match + '.' : 'Beispielspiel (gerade kein passendes Live-Spiel mit 1 Tor).');
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
document.getElementById('af-btn').addEventListener('click', async () => {
  const out = document.getElementById('af-out');
  out.textContent = 'Prüfe …';
  try {
    const r = await fetch('/admin/api/apifootball-status', { headers: { 'Authorization': 'Bearer ' + pw() } });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || ('Fehler ' + r.status));
    if (!d.key) { out.textContent = '❌ Kein Schlüssel: In Cloudflare fehlt das Secret RAPIDAPI_KEY (oder APIFOOTBALL_KEY).'; return; }
    const lim = d.perMin ? ' · Limit pro Minute: ' + d.perMin + (d.perMinLeft != null ? ' (frei: ' + d.perMinLeft + ')' : '') : '';
    if (!d.ok) { out.textContent = '❌ API antwortet nicht richtig: ' + JSON.stringify(d.errors || { http: d.http }) + lim; return; }
    out.textContent = '✅ API-Football antwortet (' + (d.via || '') + ') · Tarif: ' + (d.plan || '?') + (d.active === false ? ' (NICHT aktiv)' : '') +
      ' · heute ' + d.used + ' von ' + d.limit + ' Abfragen genutzt' +
      (d.live != null ? ' · gerade ' + d.live + ' Live-Spiele' : ' · Live-Liste fehlt: ' + JSON.stringify(d.errors || {})) + lim + (d.end ? ' · läuft bis ' + String(d.end).slice(0, 10) : '');
  } catch (e) { out.textContent = e.message; }
});

document.getElementById('odds-btn').addEventListener('click', async () => {
  const out = document.getElementById('odds-out');
  out.textContent = 'Prüfe Quoten …';
  try {
    const r = await fetch('/admin/api/odds-probe', { headers: { 'Authorization': 'Bearer ' + pw() } });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || ('Fehler ' + r.status));
    if (!d.key) { out.textContent = 'Kein API-Football-Schlüssel.'; return; }
    if (!d.ok) { out.textContent = '❌ Keine Live-Quoten bekommen (API-Fehler oder Limit).'; return; }
    const open = (d.open || []).map((t) => (t.odds ? '✅ ' : t.live ? '🔗 ' : t.afId || t.inDay ? '📅 ' : '— ') +
      esc(t.match) + ' (Over ' + t.line + ', vor ' + t.ageMin + ' Min.)' +
      (t.near && t.near.length ? ' <span style="color:#8891a3;">· ähnlich im Spielplan: ' + esc(t.near.join(' / ')) + '</span>' : '')).join('<br>');
    out.innerHTML = 'Live-Spiele: ' + d.live + ' · mit Live-Quoten: ' + d.withOdds + ' · davon mit Über/Unter-Toren: ' + d.withOu +
      '<br>Spiele-Archiv heute: ' + d.storedToday + ' Spiele gespeichert' +
      (d.sample ? '<br>Beispiel: ' + esc(d.sample.match || String(d.sample.fixture)) + ' – Linien ' + esc(Object.keys(d.sample.lines).join(', ')) : '') +
      '<br>Wetten-Namen: ' + esc((d.topNames || []).map((n) => n[0] + ' (' + n[1] + ')').join(', ')) +
      (open ? '<br><br>Offene Tipps (✅ live mit Quoten · 🔗 live ohne Quoten · 📅 nur im Spielplan · — bei API-Football nicht gefunden):<br>' + open : '');
  } catch (e) { out.textContent = e.message; }
});

document.getElementById('matches-btn').addEventListener('click', async () => {
  const out = document.getElementById('odds-out');
  out.textContent = 'Erstelle CSV …';
  try {
    const r = await fetch('/admin/api/matches-csv?days=7', { headers: { 'Authorization': 'Bearer ' + pw() } });
    if (!r.ok) throw new Error('Fehler ' + r.status);
    const csv = await r.text();
    const name = 'moneybag_spiele_7tage_' + new Date().toISOString().slice(0, 10) + '.csv';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    out.textContent = (csv.trim().split('\\n').length - 1) + ' Spiele. Datei ' + name + ' gespeichert (iPad: Dateien-App → Downloads).';
  } catch (e) { out.textContent = e.message; }
});

document.getElementById('res-csv-btn').addEventListener('click', async () => {
  const out = document.getElementById('res-out');
  out.textContent = 'Erstelle CSV …';
  try {
    const r = await fetch('/admin/api/results-csv?days=30', { headers: { 'Authorization': 'Bearer ' + pw() } });
    if (!r.ok) throw new Error('Fehler ' + r.status);
    const csv = await r.text();
    const name = 'moneybag_ergebnisse_30tage_' + new Date().toISOString().slice(0, 10) + '.csv';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    // Fallback for browsers that ignore blob downloads (some iPad browsers): show it to copy.
    out.innerHTML = '<div style="font-size:0.8rem;margin-bottom:6px;">' + (csv.trim().split('\\n').length - 1) +
      ' Tipps. Datei ' + esc(name) + ' wurde gespeichert (iPad: Dateien-App → Downloads). Falls kein Download startet: Text kopieren.</div>' +
      '<textarea readonly style="width:100%;height:160px;background:#202634;color:#e6e9f0;border:1px solid #2c3444;font-size:0.7rem;">' + esc(csv) + '</textarea>';
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
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // --- Public results page (no access token needed) ---
    if (url.pathname === "/ergebnisse" || url.pathname === "/ergebnisse/") {
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
      return resultsPage(request, env, ctx);
    }

    if (url.pathname === "/videos" || url.pathname === "/videos/") return videosPage();
    if (url.pathname === "/test-starten") {
      const bot = env.TELEGRAM_BOT_TOKEN ? await botUsername(env) : null;
      if (!bot) return Response.redirect(`${url.origin}/#test`, 302);
      return Response.redirect(`https://t.me/${bot}?start=test`, 302);
    }
    if (url.pathname === "/partner" || url.pathname === "/partner/") return partnerPage();
    {
      const pm = url.pathname.match(/^\/partner\/([A-Za-z0-9_-]+\.(png|jpg|webp))$/);
      if (pm && PARTNERS.some((p) => p[4] === pm[1])) {
        const a = await env.ASSETS.fetch(new Request(new URL(url.pathname, url.origin)));
        if (!a.ok) return new Response("Not found", { status: 404 });
        const type = pm[2] === "png" ? "image/png" : pm[2] === "webp" ? "image/webp" : "image/jpeg";
        return new Response(a.body, { headers: { "Content-Type": type, "Cache-Control": "public, max-age=86400" } });
      }
    }
    {
      const vm = url.pathname.match(/^\/videos\/([a-z0-9]+)\.(mp4|jpg)$/);
      if (vm && VIDEOS.some(([slug]) => slug === vm[1])) {
        // Safari / iPad only plays video that is served in byte ranges (206). The asset binding returns the whole
        // file, so the range is cut here (files are ~0.6 MB).
        const a = await env.ASSETS.fetch(new Request(new URL(url.pathname, url.origin)));
        if (!a.ok) return new Response("Not found", { status: 404 });
        const type = vm[2] === "mp4" ? "video/mp4" : "image/jpeg";
        const buf = await a.arrayBuffer();
        const base = { "Content-Type": type, "Cache-Control": "public, max-age=604800", "Accept-Ranges": "bytes" };
        const rm = (request.headers.get("Range") || "").match(/^bytes=(\d*)-(\d*)$/);
        if (rm && (rm[1] || rm[2])) {
          let start = rm[1] ? parseInt(rm[1], 10) : buf.byteLength - parseInt(rm[2], 10);
          let end = rm[1] && rm[2] ? Math.min(parseInt(rm[2], 10), buf.byteLength - 1) : buf.byteLength - 1;
          start = Math.max(0, start);
          if (start > end || start >= buf.byteLength) {
            return new Response(null, { status: 416, headers: { ...base, "Content-Range": `bytes */${buf.byteLength}` } });
          }
          return new Response(buf.slice(start, end + 1), { status: 206, headers: { ...base, "Content-Range": `bytes ${start}-${end}/${buf.byteLength}`, "Content-Length": String(end - start + 1) } });
        }
        return new Response(buf, { headers: { ...base, "Content-Length": String(buf.byteLength) } });
      }
    }
    if (url.pathname === "/og.png") {
      const img = await env.ASSETS.fetch(new Request(new URL("/og.png", url.origin)));
      return new Response(img.body, { status: img.status, headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" } });
    }
    if (url.pathname === "/favicon.svg" || url.pathname === "/favicon.ico") {
      return new Response(FAVICON_SVG, { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" } });
    }
    // --- Search engines: only the public results page is meant to be found ---
    if (url.pathname === "/robots.txt") {
      return new Response(`User-agent: *\nAllow: /$\nAllow: /ergebnisse\nAllow: /videos\nAllow: /partner\nDisallow: /admin\nDisallow: /api/\nDisallow: /telegram-webhook\n\nSitemap: ${url.origin}/sitemap.xml\n`,
        { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
    }
    if (url.pathname === "/sitemap.xml") {
      return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n<url><loc>${url.origin}/</loc><changefreq>daily</changefreq></url>\n<url><loc>${url.origin}/ergebnisse</loc><changefreq>hourly</changefreq></url>\n<url><loc>${url.origin}/videos</loc><changefreq>weekly</changefreq></url>\n<url><loc>${url.origin}/partner</loc><changefreq>weekly</changefreq></url>\n</urlset>\n`,
        { headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
    }

    // --- Terms and withdrawal policy ---
    if (url.pathname === "/agb" || url.pathname === "/agb/") return legalPage(env, "agb");
    if (url.pathname === "/widerruf" || url.pathname === "/widerruf/") return legalPage(env, "widerruf");
    if (url.pathname === "/datenschutz" || url.pathname === "/datenschutz/") return legalPage(env, "datenschutz");

    // --- Legal notice (Impressum) ---
    if (url.pathname === "/impressum" || url.pathname === "/impressum/") {
      return impressumPage(env);
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
    // Weekly results image to the free channel: the admin page draws the
    // 7-day image in the browser (canvas) and uploads the PNG here; the
    // worker posts it with sendPhoto. Workers have no canvas, so the drawing
    // stays in the browser.
    if (url.pathname === "/admin/api/post-bilanz" && request.method === "POST") {
      if (!isAdminAuthed(request, env)) return jsonResponse({ error: "unauthorized" }, 401);
      const png = await request.arrayBuffer();
      const head = new Uint8Array(png.slice(0, 8));
      const isPng = head.length === 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
      if (!isPng || png.byteLength > 5 * 1024 * 1024) return jsonResponse({ error: "Kein PNG-Bild (max. 5 MB)." }, 400);
      const form = new FormData();
      form.append("chat_id", freeChannel(env));
      form.append("caption", `📊 Wochenbilanz – alle Tipps der letzten 7 Tage, Treffer und Verluste.\n\n${freeCta(env)}`);
      form.append("photo", new Blob([png], { type: "image/png" }), "bilanz.png");
      const resp = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`, { method: "POST", body: form });
      const data = await resp.json().catch(() => null);
      return jsonResponse({ sent: !!(data && data.ok), channel: freeChannel(env) });
    }

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
      if (url.searchParams.get("tier") === "o15") {
        // Same layout as a real Over 1.5 Test post, on the live 1-goal match
        // closest to minute 58 (or a sample match). Not tracked or logged.
        let pick = null;
        if (feedOk) {
          const live = feed
            .map((m) => ({ m, s: liveSnapshot(m) }))
            .filter((x) => x.s.minute != null && x.s.minute >= 20 && x.s.minute <= 85 && x.s.goals === 1);
          live.sort((a, b) => Math.abs(a.s.minute - 58) - Math.abs(b.s.minute - 58));
          pick = live[0] || null;
        }
        const s = pick ? pick.s : { minute: 58, score: "1-0", radar: null, goallinePre: 3, redCards: 0 };
        const odds = pick ? oddsSnapshot(pick.m) : null;
        const pre = s.goallinePre;
        const wouldPass = s.minute <= O15_MAX_MINUTE && pre != null && pre >= O15_MIN_LINE_PRE && s.redCards === 0;
        matchInfo = pick ? `${pick.m.h} – ${pick.m.a} (${s.minute}' ${s.score})` : null;
        text = [
          "🧪 TEST – kein Tipp, bitte nicht setzen",
          `🧪 Over 1.5 Test (Minute ${s.minute}' · Vor-Spiel-Linie ${pre != null ? String(pre).replace(".", ",") : "–"})`,
          "",
          pick ? `🏆 ${pick.m.l || ""}` : "🏆 Beispiel-Liga",
          pick ? `⚽ ${pick.m.h} ${s.score} ${pick.m.a}` : "⚽ Heim FC 1-0 Gast FC (Beispiel)",
          "🎯 Target: Over 1.5 Goals",
          `📡 Radar X: ${s.radar != null ? s.radar : "–"}`,
          odds ? `Quote: ${oddsText(odds)}` : null,
          "",
          "Testbetrieb seit 21.10.: Rückblick 76 % (522 Spiele), halber Einsatz.",
          stakeAdvice(1.5, minQuote(O15_WR), UNITS_HALF, odds),
          "",
          `Echt gepostet wird nur bei Over-1.5-Karten bis Minute ${O15_MAX_MINUTE} mit Vor-Spiel-Linie ab 2,75. ${pick ? `Dieses Spiel: ${wouldPass ? "würde passen" : "würde nicht passen"}.` : "Gerade kein passendes Live-Spiel mit 1 Tor, daher Beispielspiel."}`,
        ].filter((x) => x != null).join("\n");
        const sent = await sendTelegramMessage(env, env.PREMIUM_CHANNEL_ID, text);
        return jsonResponse({ sent: !!sent, feedOk, matches: feedOk ? feed.length : 0, match: matchInfo, wouldPass: pick ? wouldPass : null });
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
          const units = goal.points >= 1 || strongO05({ targetLine: line, goallinePre: s.goallinePre }) ? UNITS_STRONG : UNITS_NORMAL;
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
        days, summary: sum, open: (await readTracked(env)).filter((t) => !t.settledKey), rows,
        reportPreview: weeklyReportText(sum, new Date(to.getTime() - days * DAY_MS), to),
      });
    }

    if (url.pathname === "/admin/api/odds-probe" && request.method === "GET") {
      if (!isAdminAuthed(request, env)) return jsonResponse({ error: "unauthorized" }, 401);
      return jsonResponse(await apiOddsProbe(env));
    }

    // Own match archive from API-Football as CSV (owner downloads, uploads here for analyses).
    if (url.pathname === "/admin/api/matches-csv" && request.method === "GET") {
      if (!isAdminAuthed(request, env)) return jsonResponse({ error: "unauthorized" }, 401);
      const days = Math.min(Number(url.searchParams.get("days")) || 7, 180);
      return new Response(matchesCsv(await listMatches(env, days)), { headers: { "Content-Type": "text/csv; charset=utf-8" } });
    }

    if (url.pathname === "/admin/api/apifootball-status" && request.method === "GET") {
      if (!isAdminAuthed(request, env)) return jsonResponse({ error: "unauthorized" }, 401);
      return jsonResponse(await apiFootballStatus(env));
    }

    // All settled tips of the last N days as CSV (owner, 31.10.: for the profit / market check per tier).
    if (url.pathname === "/admin/api/results-csv" && request.method === "GET") {
      if (!isAdminAuthed(request, env)) return jsonResponse({ error: "unauthorized" }, 401);
      const days = Math.min(Number(url.searchParams.get("days")) || 30, 365);
      const rows = await listResults(env, Date.now() - days * DAY_MS);
      return new Response(resultsCsv(rows), { headers: { "Content-Type": "text/csv; charset=utf-8" } });
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
              const fast = !snap.match && snap.guestFeed && !afOn(env);
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
                (odds && !odds.live ? `\nQuote: ${oddsText(odds)}` : "") + "\n\n" +
                stakeAdvice(parsed.targetLine, mq, UNITS_RISK, odds));
            await trackSignal(env, {
              ...post,
              tier: "risk", home: parsed.homeTeam, away: parsed.awayTeam, matchId: snap.matchId,
              line: parsed.targetLine, minute: parsed.minute, minQuote: mq, units: UNITS_RISK, odds,
              signalQuote: cardQuote(parsed),
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
        const keep = isAdmin && msg.text && msg.text.match(/^\/behalten\s+(\d+)/);
        if (keep) {
          const gone = (await env.ACCESS_KV.list({ prefix: "trialend:" })).keys.filter((k) => k.name.endsWith(`:${keep[1]}`));
          for (const k of gone) await env.ACCESS_KV.delete(k.name);
          await sendTelegramMessage(env, msg.chat.id, gone.length ? `✅ ID ${keep[1]} bleibt im Premium-Kanal (wird nicht automatisch entfernt). Tool-Zugang bei Bedarf im Admin verlängern.` : `Für ID ${keep[1]} läuft kein Test.`);
        } else if (!isAdmin && msg.text && /^\/start\s+test\b/.test(msg.text)) {
          await startTrial(env, msg, url.origin);
        } else if (isAdmin) {
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
      // Start page trial form: a Telegram username is enough as contact (email optional there).
      // Partner page join form (since 30.10.): channel link + description required, contact via Telegram or email.
      const partner = body.kind === "partner";
      const trial = body.kind === "trial" || partner;
      const tg = String(body.telegram || "").trim().replace(/^@/, "").slice(0, 40);
      const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
      const tgOk = /^[A-Za-z0-9_]{5,32}$/.test(tg);
      const channel = partner ? partnerChannel(body.channel) : null;
      if (partner && (!channel || !message)) {
        return jsonResponse({ error: "Bitte einen gültigen Kanal-Link (t.me/…) und 1–2 Sätze zu deinem Kanal angeben." }, 400);
      }
      if (!name || (trial ? !(emailOk || tgOk) || (email && !emailOk) || (tg && !tgOk) : !emailOk)) {
        return jsonResponse({ error: trial ? "Bitte Name und deinen Telegram-Namen (@…) oder eine E-Mail-Adresse angeben." : "Bitte Name und eine gültige E-Mail-Adresse angeben." }, 400);
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
        partner ? "🤝 Neue Partner-Anfrage (Seite /partner)" : trial ? "🎁 Neue Anfrage: 24h-Test Premium (Startseite)" : "📬 Neue Kontaktanfrage (MoneyBag Analyst, Formular)",
        `Name: ${name}`,
        channel ? `Kanal: ${channel}` : null,
        tg ? `Telegram: @${tg} → https://t.me/${tg}` : null,
        !email ? null : looksLikeFakeEmail(email) ? `E-Mail: ${email} ⚠️ wirkt wie Fake-/Wegwerf-Adresse` : `E-Mail: ${email}`,
        message ? `${partner ? "Beschreibung" : "Nachricht"}: ${message}` : null,
        partner ? "Regeln + Gegen-Empfehlung + 18+ bestätigt. Banner per Telegram anfordern." : null,
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
    if (!resolved.ok && resolved.reason === "missing" && url.pathname === "/" && (request.method === "GET" || request.method === "HEAD")) {
      return landingPage(request, env, ctx);
    }
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
    else if (event.cron === DAILY_CRON) ctx.waitUntil(sendDailyReport(env));
    else {
      ctx.waitUntil(runMinuteJobs(env));
      if (new Date().getUTCMinutes() % 10 === 0) ctx.waitUntil(endTrials(env));
    }
  },
};
