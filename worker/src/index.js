const COOKIE_NAME = "mb_access";
const DAY_MS = 24 * 60 * 60 * 1000;

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
</style></head>
<body>
  <h1>Zugang erforderlich</h1>
  <p>${message}</p>
  <div class="box">
    <p><strong>Weiter nutzen?</strong><br>
    Kontaktiere uns über Telegram, um freigeschaltet zu werden.</p>
  </div>
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

    // --- Public access-gated page ---
    const cookies = parseCookies(request);
    const queryToken = url.searchParams.get("t");
    const token = queryToken || cookies[COOKIE_NAME];

    if (!token) {
      return deniedPage({ reason: "missing" });
    }

    const access = await getAccess(env, token);
    if (!access) {
      return deniedPage({ reason: "invalid" });
    }
    if (access.expiresAt < Date.now()) {
      return deniedPage({ reason: "expired" });
    }

    // Valid access. If the token came from the URL, set a cookie and
    // redirect to a clean URL so the token doesn't linger in the address bar.
    if (queryToken) {
      const maxAge = Math.floor((access.expiresAt - Date.now()) / 1000);
      const headers = new Headers({ Location: url.origin + "/" });
      headers.append(
        "Set-Cookie",
        `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; SameSite=Lax; Secure; HttpOnly`
      );
      return new Response(null, { status: 302, headers });
    }

    return env.ASSETS.fetch(new Request(url.origin + "/index.html", request));
  },
};
