import test from "node:test";
import assert from "node:assert/strict";
import { loadWorker, makeEnv, mockNet, webhook, cron, admin, card, tracked, results } from "./helpers.mjs";

const worker = await loadWorker();
const premiumPosts = (net) => net.sent.filter((m) => m.method === "sendMessage" && m.chat_id === "-100");

test("security: guessable KV keys never open the tool, admin page headers", async () => {
  mockNet({ feed: [] });
  const env = makeEnv();
  env.ACCESS_KV.store.set("premium:pending", "[]");
  assert.equal((await worker.fetch(new Request("https://x/?t=premium:pending"), env, {})).status, 403);
  const r = await worker.fetch(new Request("https://x/admin"), env, {});
  assert.equal(r.headers.get("x-frame-options"), "DENY");
  assert.equal((await admin(worker, env, "/admin/api/results?days=7", { headers: { Authorization: "Bearer wrong" } })).status, 401);
});

test("admin page and results page: every inline script parses", async () => {
  mockNet({ feed: [] });
  const env = makeEnv();
  for (const p of ["/admin", "/ergebnisse"]) {
    const html = await (await worker.fetch(new Request("https://x" + p), env, {})).text();
    for (const [, js] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      assert.doesNotThrow(() => new Function(js), `script in ${p} does not parse`);
    }
  }
});

test("High Confidence: queued by the webhook, posted once by the cron even if three strategies send it", async () => {
  const net = mockNet({ feed: [] });
  const env = makeEnv();
  for (const h of ["💰 MoneyBag 2-0/0-2 → Over 2.5 New", "Over 2.5 Value", "Over 2.5 Odd Filter"]) {
    await webhook(worker, env, card({ header: h }));
  }
  assert.equal(premiumPosts(net).length, 0, "webhook must not post");
  await cron(worker, env);
  await cron(worker, env);
  assert.equal(premiumPosts(net).length, 1);
  const t = tracked(env);
  assert.equal(t.length, 1);
  assert.equal(t[0].tier, "premium");
  assert.ok(t[0].signalQuote && t[0].signalQuote.over > 1, "quote from the card is stored");
});

test("O0.5 at 0:0: 2 units from pre-match line 4.0, 1 unit below", async () => {
  for (const [pre, units] of [["4.0", 2], ["3.5", 1]]) {
    const net = mockNet({ feed: [] });
    const env = makeEnv();
    await webhook(worker, env, card({ header: "💰 MoneyBag 0-0 → Goal", score: "0-0", target: "Goal", minute: 61, sot: [3, 2], radar: 380, pre, live: "1.5", over: "2.10", under: "1.70" }));
    await cron(worker, env);
    assert.equal(tracked(env)[0].units, units, `line ${pre}`);
    assert.match(premiumPosts(net)[0].text, new RegExp(`Einsatz: ${units} Einheit`));
  }
});

test("Over 1.5 Test: rule minute <= 61 and line >= 2.75, rejected after a goal", async () => {
  const cases = [
    { minute: 58, pre: "3.0", feed: [], posts: 1 },
    { minute: 62, pre: "3.0", feed: [], posts: 0 },
    { minute: 58, pre: "2.5", feed: [], posts: 0 },
    { minute: 58, pre: "3.0", feed: [{ id: "m", h: "Alpha FC", a: "Beta FC", minute: "59", hg: "1", ag: "1", ou_odds: ["1.9", "1.9", "2.5"] }], posts: 0 },
  ];
  for (const c of cases) {
    const net = mockNet({ feed: c.feed });
    const env = makeEnv();
    await webhook(worker, env, card({ header: "💰  Over 1.5 Value", score: "1-0", target: "Goal", minute: c.minute, pre: c.pre, live: "2.5" }));
    await cron(worker, env);
    assert.equal(premiumPosts(net).length, c.posts, JSON.stringify(c));
    if (c.posts) assert.equal(tracked(env)[0].tier, "o15");
  }
});

test("settling: exact goal minute from the feed, WIN banner, free channel, result record", async () => {
  const net = mockNet({ feed: [] });
  const env = makeEnv();
  await webhook(worker, env, card());
  await cron(worker, env);
  net.feed = [{ id: "m", h: "Alpha FC", a: "Beta FC", minute: "88", hg: "3", ag: "0", sonGolDakikasi: "71", ou_odds: ["1.9", "1.9", "3.5"] }];
  await cron(worker, env);
  const edit = net.sent.find((m) => m.method === "editMessageText");
  assert.ok(edit && edit.text.startsWith("✅ WIN – Tor in Minute 71'"), edit && edit.text);
  assert.ok(net.sent.some((m) => m.chat_id === "@MoneyBagAnalyst"), "free channel post");
  const r = results(env)[0];
  assert.equal(r.result, "won");
  assert.equal(r.resultMinute, 71);
  assert.ok(r.quote > 1 && r.marketP > 0 && r.wait, "quote, market and wait estimate stored");
  assert.equal(tracked(env).length, 0);
});

test("settling with two goals: minute unknown, banner without minute", async () => {
  const net = mockNet({ feed: [] });
  const env = makeEnv();
  await webhook(worker, env, card());
  await cron(worker, env);
  net.feed = [{ id: "m", h: "Alpha FC", a: "Beta FC", minute: "88", hg: "4", ag: "0", sonGolDakikasi: "85", ou_odds: ["1.9", "1.9", "4.5"] }];
  await cron(worker, env);
  const edit = net.sent.find((m) => m.method === "editMessageText");
  assert.ok(edit.text.startsWith("✅ WIN – Tor\n"), edit.text);
});

function seedResults(env, n, wins, extra = {}) {
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    const r = { tier: "premium", home: "H" + i, away: "A" + i, line: 2.5, minute: 60, units: 1,
      postedAt: new Date(now - (i + 2) * 3600e3).toISOString(), settledAt: new Date(now - (i + 1) * 3600e3).toISOString(),
      result: i < wins ? "won" : "lost", quote: 1.3, marketP: 0.75, ...extra };
    const k = `result:${now - (i + 1) * 3600e3}:${i}`;
    env.ACCESS_KV.store.set(k, JSON.stringify(r));
    env.ACCESS_KV.meta.set(k, r);
  }
}

test("early warning: bad run of a tier -> one private message per day, none on a good run", async () => {
  for (const [wins, expectWarn] of [[14, true], [24, false]]) {
    const net = mockNet({ feed: [] });
    const env = makeEnv();
    seedResults(env, 29, wins);
    await webhook(worker, env, card());
    await cron(worker, env);
    net.feed = [{ id: "m", h: "Alpha FC", a: "Beta FC", minute: "88", hg: "3", ag: "0", sonGolDakikasi: "70", ou_odds: ["1.9", "1.9", "3.5"] }];
    await cron(worker, env);
    const warns = net.sent.filter((m) => m.chat_id === "777" && m.text.includes("Frühwarnung"));
    assert.equal(warns.length, expectWarn ? 1 : 0, `wins ${wins}`);
  }
});

test("weekly cron: private Wochen-Check for the owner plus the channel reports", async () => {
  const net = mockNet({ feed: [] });
  const env = makeEnv();
  seedResults(env, 25, 20);
  await cron(worker, env, "0 8 * * 1");
  const own = net.sent.find((m) => m.chat_id === "777");
  assert.ok(own && own.text.includes("Wochen-Check") && own.text.includes("Markt erwartete"), own && own.text);
  assert.ok(net.sent.some((m) => m.chat_id === "-100" && m.text.includes("Wochenbilanz")));
  assert.ok(net.sent.some((m) => m.chat_id === "@MoneyBagAnalyst" && m.text.includes("Keine Gewinngarantie")));
});

test("results page: escapes names, profit line from 20 quoted tips, admin summary has the market comparison", async () => {
  mockNet({ feed: [] });
  const env = makeEnv();
  seedResults(env, 25, 20, { home: "Team <b>x" });
  const html = await (await worker.fetch(new Request("https://x/ergebnisse"), env, {})).text();
  assert.ok(html.includes("Team &lt;b&gt;x") && !html.includes("Team <b>x"));
  assert.ok(html.includes("wenn jeder Tipp zur Quote beim Signal gesetzt wurde"));
  const d = await (await admin(worker, env, "/admin/api/results?days=7")).json();
  assert.equal(d.summary.market.premium.n, 25);
  assert.equal(d.summary.quotedAll, 25);
});

test("admin test posts are marked TEST and never tracked", async () => {
  const net = mockNet({ feed: [] });
  const env = makeEnv();
  for (const q of ["", "?line=0.5", "?tier=half", "?tier=o15", "?tier=under"]) {
    const r = await admin(worker, env, "/admin/api/test-post" + q, { method: "POST" });
    assert.equal(r.status, 200, q);
  }
  assert.ok(premiumPosts(net).every((m) => m.text.includes("TEST")));
  assert.equal(tracked(env).length, 0);
});

test("queue: cards arriving at the same moment are all kept (one KV key per card)", async () => {
  const net = mockNet({ feed: [] });
  const env = makeEnv();
  await Promise.all(["Gamma FC", "Delta FC", "Eps FC", "Zeta FC"].map((h, i) =>
    webhook(worker, env, card({ home: h, away: "Opp " + i }))));
  await cron(worker, env);
  assert.equal(premiumPosts(net).length, 4);
  assert.equal([...env.ACCESS_KV.store.keys()].filter((k) => k.startsWith("pending:")).length, 0, "queue emptied");
});

test("queue: cards still in the old single list are posted and the old key removed", async () => {
  const net = mockNet({ feed: [] });
  const env = makeEnv();
  const parsed = { homeTeam: "Old FC", awayTeam: "List FC", targetLine: 2.5, minute: 56, goals: 2 };
  env.ACCESS_KV.store.set("premium:pending", JSON.stringify([{ id: "legacy1", text: "x", parsed, proba: 0.85, receivedAt: Date.now() - 600000, fast: true }]));
  await cron(worker, env);
  assert.equal(premiumPosts(net).length, 1);
  assert.equal(env.ACCESS_KV.store.has("premium:pending"), false);
});

test("daily report: private summary of the last 24 h, flags a line that went quiet, not on Mondays", async () => {
  const net = mockNet({ feed: [] });
  const env = makeEnv();
  const now = Date.now();
  const put = (i, hoursAgo, line, result) => {
    const r = { tier: "premium", home: "H" + i, away: "A" + i, line, minute: 60, units: 1, result, quote: 1.3, marketP: 0.75,
      postedAt: new Date(now - (hoursAgo + 1) * 3600e3).toISOString(), settledAt: new Date(now - hoursAgo * 3600e3).toISOString() };
    env.ACCESS_KV.store.set(`result:${now - hoursAgo * 3600e3}:${i}`, JSON.stringify(r));
    env.ACCESS_KV.meta.set(`result:${now - hoursAgo * 3600e3}:${i}`, r);
  };
  for (let i = 0; i < 6; i++) put(i, 2 + i, 2.5, i % 3 ? "won" : "lost");          // yesterday: O2.5 only
  for (let i = 0; i < 20; i++) put(100 + i, 30 + i * 6, 0.5, "won");                // O0.5 earlier in the week only
  const realDay = Date.prototype.getUTCDay;
  Date.prototype.getUTCDay = () => 3;
  try {
    await cron(worker, env, "0 7 * * *");
  } finally {
    Date.prototype.getUTCDay = realDay;
  }
  const msg = net.sent.find((m) => m.chat_id === "777");
  assert.ok(msg && msg.text.includes("Tages-Bericht") && msg.text.includes("4/6"), msg && msg.text);
  assert.ok(msg.text.includes("Keine Tipps mehr für Over 0.5"), msg.text);
  assert.ok(!msg.text.includes("Keine Tipps mehr für Over 2.5"));
  assert.equal(net.sent.filter((m) => m.chat_id !== "777").length, 0, "nothing to the channels");
  const net2 = mockNet({ feed: [] });
  Date.prototype.getUTCDay = () => 1;
  try {
    await cron(worker, env, "0 7 * * *");
  } finally {
    Date.prototype.getUTCDay = realDay;
  }
  assert.equal(net2.sent.length, 0, "no daily report on Mondays");
});

test("impressum: hidden without the Cloudflare variables, shown (escaped) with them, linked from the results page", async () => {
  mockNet({ feed: [] });
  const none = makeEnv();
  assert.equal((await worker.fetch(new Request("https://x/impressum"), none, {})).status, 404);
  assert.ok(!(await (await worker.fetch(new Request("https://x/ergebnisse"), none, {})).text()).includes("/impressum"));
  const env = makeEnv({ IMPRESSUM_NAME: "Max <Muster>", IMPRESSUM_ADDRESS: "Musterweg 1|12345 Musterstadt" });
  const r = await worker.fetch(new Request("https://x/impressum"), env, {});
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("x-frame-options"), "DENY");
  const html = await r.text();
  for (const want of ["Max &lt;Muster&gt;", "Musterweg 1<br>12345 Musterstadt", "kontakt@moneybag-signals.com", "§ 5 DDG", "kein Wettanbieter"]) {
    assert.ok(html.includes(want), want);
  }
  assert.ok((await (await worker.fetch(new Request("https://x/ergebnisse"), env, {})).text()).includes('href="/impressum"'));
});

test("weekly image: admin uploads the PNG, the worker posts it to the free channel with sendPhoto", async () => {
  const net = mockNet({ feed: [] });
  const env = makeEnv();
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const post = (body, auth = "Bearer pw") => worker.fetch(new Request("https://x/admin/api/post-bilanz", {
    method: "POST", headers: { Authorization: auth, "Content-Type": "image/png" }, body }), env, {});
  assert.equal((await post(png, "Bearer wrong")).status, 401);
  assert.equal((await post(new Uint8Array([1, 2, 3]))).status, 400);
  const r = await post(png);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).sent, true);
  const photo = net.sent.find((m) => m.method === "sendPhoto");
  assert.equal(photo.chat_id, "@MoneyBagAnalyst");
  assert.ok(photo.caption.includes("Wochenbilanz") && photo.caption.includes("Keine Gewinngarantie"));
  assert.ok(photo.photo instanceof Blob);
});

test("search engines: robots.txt allows only the results page, sitemap lists it", async () => {
  mockNet({ feed: [] });
  const env = makeEnv();
  const robots = await (await worker.fetch(new Request("https://moneybag-signals.com/robots.txt"), env, {})).text();
  assert.match(robots, /Allow: \/ergebnisse/);
  assert.match(robots, /Disallow: \/admin/);
  assert.match(robots, /Sitemap: https:\/\/moneybag-signals.com\/sitemap.xml/);
  const sm = await worker.fetch(new Request("https://moneybag-signals.com/sitemap.xml"), env, {});
  assert.match(sm.headers.get("Content-Type"), /xml/);
  assert.match(await sm.text(), /<loc>https:\/\/moneybag-signals.com\/ergebnisse<\/loc>/);
});

test("start page: visitors without a link get the public page with live numbers, a bad link still gets the access page", async () => {
  mockNet({ feed: [] });
  const env = makeEnv();
  seedResults(env, 10, 0);
  const res = await worker.fetch(new Request("https://moneybag-signals.com/"), env, {});
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /20 € \/ Monat/);
  assert.match(html, /24 Stunden Premium kostenlos testen/);
  assert.match(html, /kontakt@moneybag-signals.com/);
  assert.match(html, /18\+/);
  assert.match(html, /von 10 Signalen/);
  for (const [, js] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Function(js);
  const bad = await worker.fetch(new Request("https://moneybag-signals.com/?t=premium:pending"), env, {});
  assert.equal(bad.status, 403);
  const sm = await (await worker.fetch(new Request("https://moneybag-signals.com/sitemap.xml"), env, {})).text();
  assert.match(sm, /<loc>https:\/\/moneybag-signals.com\/<\/loc>/);
});

test("AGB and Widerruf: 404 without the Impressum variables, shown (escaped) with them, linked from the footers", async () => {
  mockNet({ feed: [] });
  const bare = makeEnv();
  assert.equal((await worker.fetch(new Request("https://x/agb"), bare, {})).status, 404);
  const env = makeEnv({ IMPRESSUM_NAME: "Max <M>", IMPRESSUM_ADDRESS: "Weg 1|12345 Ort" });
  const agb = await (await worker.fetch(new Request("https://x/agb"), env, {})).text();
  assert.match(agb, /§ 19 UStG/);
  assert.match(agb, /PayPal/);
  assert.match(agb, /Testzugang für 24 Stunden/);
  assert.match(agb, /Max &lt;M&gt;, Weg 1, 12345 Ort/);
  const w = await (await worker.fetch(new Request("https://x/widerruf"), env, {})).text();
  assert.match(w, /Muster-Widerrufsformular/);
  const start = await (await worker.fetch(new Request("https://x/"), env, {})).text();
  assert.match(start, /href="\/agb"/);
  assert.match(start, /href="\/widerruf"/);
});

test("privacy policy: 404 without the Impressum variables, shown with them, linked from the start page; tool loads no Google Fonts", async () => {
  mockNet({ feed: [] });
  assert.equal((await worker.fetch(new Request("https://x/datenschutz"), makeEnv(), {})).status, 404);
  const env = makeEnv({ IMPRESSUM_NAME: "Max", IMPRESSUM_ADDRESS: "Weg 1|12345 Ort" });
  const ds = await (await worker.fetch(new Request("https://x/datenschutz"), env, {})).text();
  for (const w of ["Cloudflare", "mb_access", "Kontaktformular", "PayPal", "Telegram", "BayLDA"]) assert.ok(ds.includes(w), w);
  const start = await (await worker.fetch(new Request("https://x/"), env, {})).text();
  assert.match(start, /href="\/datenschutz"/);
  const fs = await import("node:fs");
  assert.ok(!fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8").includes("fonts.googleapis"));
});

test("start page trial form: a Telegram name is enough, the request reaches the owner on Telegram", async () => {
  const net = mockNet({ feed: [] });
  const env = makeEnv();
  const html = await (await worker.fetch(new Request("https://x/"), env, {})).text();
  assert.match(html, /id="trial"/);
  for (const [, js] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Function(js);
  const post = (body, ip) => worker.fetch(new Request("https://x/api/contact", { method: "POST", headers: { "CF-Connecting-IP": ip }, body: JSON.stringify(body) }), env, {});
  assert.equal((await post({ kind: "trial", name: "Max", telegram: "@ab" }, "1")).status, 400);
  assert.equal((await post({ kind: "trial", name: "Max" }, "2")).status, 400);
  const ok = await post({ kind: "trial", name: "Max", telegram: "@max_muster" }, "3");
  assert.equal(ok.status, 200);
  const msg = net.sent.find((m) => m.chat_id === "777");
  assert.match(msg.text, /24h-Test/);
  assert.match(msg.text, /@max_muster/);
  assert.equal((await post({ name: "Max", telegram: "max_muster" }, "4")).status, 400, "normal contact form still needs an email");
});
