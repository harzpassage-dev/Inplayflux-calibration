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
    mean: [57.394, 5.7405, 319.1647, 2.9703],
    std: [4.3973, 2.4147, 80.1697, 0.5983],
    coef: [-0.253, 0.0588, 0.0087, 0.268],
    intercept: 1.1357,
    threshold: 0.80,
  },
  3.5: {
    mean: [62.0704, 7.0409, 334.1218, 2.9762],
    std: [3.1945, 2.5805, 82.0656, 0.6364],
    coef: [-0.2262, 0.0757, 0.0567, 0.1668],
    intercept: 0.8502,
    threshold: 0.75,
  },
  1.5: {
    // Merged across all three "Over 1.5" bot-template variants.
    mean: [62.9716, 6.0993, 378.9803, 3.2139],
    std: [3.9398, 2.3317, 71.7645, 0.4997],
    coef: [-0.2601, -0.0188, 0.3248, 0.1751],
    intercept: 1.0728,
    threshold: 0.80,
  },
  0.5: {
    mean: [61.2245, 3.9767, 332.3947, 3.0977],
    std: [0.5908, 2.514, 76.2783, 0.579],
    coef: [-0.0611, 0.1548, 0.0886, 0.3934],
    intercept: 1.0059,
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
function buildPremiumMessage(text, proba) {
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
  return `🔥 High Confidence (${Math.round(proba * 100)}%)\n\n${kept.join("\n")}`;
}

// Logs every premium-channel forward so it can later be cross-referenced
// against a fresh CSV export (same join fields analyze_signals.py uses:
// date, teams, signal minute) to check the model's real-world hit rate.
async function logPremiumForward(env, parsed, score) {
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
    modelProba: Math.round(score.proba * 1000) / 1000,
    threshold: score.threshold,
  };
  const key = `premium:fwd:${now.getTime()}:${randomToken().slice(0, 8)}`;
  await env.ACCESS_KV.put(key, JSON.stringify(record), { expirationTtl: 180 * 24 * 60 * 60 });
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
            rows.push(JSON.parse(raw));
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

        // High-confidence auto-forward to the premium channel (O2.5/O3.5 only).
        if (env.PREMIUM_CHANNEL_ID) {
          const parsed = parseForConfidenceScore(channelMsg.text);
          const score = computeConfidenceScore(parsed);
          if (score && score.passes) {
            await sendTelegramMessage(
              env,
              env.PREMIUM_CHANNEL_ID,
              buildPremiumMessage(channelMsg.text, score.proba)
            );
            await logPremiumForward(env, parsed, score);
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
};
