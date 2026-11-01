import test from "node:test";
import assert from "node:assert/strict";
import { loadWorker, makeEnv, mockNet, webhook, cron, admin, card, tracked, results, afFix, afOdds } from "./helpers.mjs";

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

test("0:0 card with the new target wording \"Any goal scored\" is read as O0.5", async () => {
  for (const target of ["Any goal scored", "Any Goal", "Goal"]) {
    const net = mockNet({ feed: [] });
    const env = makeEnv();
    await webhook(worker, env, card({ header: "💰 MoneyBag 0-0 → Goal", score: "0-0", target, minute: 61, sot: [3, 2], radar: 380, pre: "4.0", live: "1.5", over: "2.10", under: "1.70" }));
    await cron(worker, env);
    assert.equal(tracked(env)[0]?.line, 0.5, target);
    assert.equal(premiumPosts(net).length, 1, target);
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

test("Over 1.5 Test: women, youth and reserve games are not posted (men only since 29.10.)", async () => {
  const cases = [
    { league: "England National League", home: "Alpha FC", away: "Beta FC", posts: 1 },
    { league: "Brazil Campeonato Women", home: "Alpha FC", away: "Beta FC", posts: 0 },
    { league: "England Premier League", home: "Alpha (W)", away: "Beta (W)", posts: 0 },
    { league: "Sweden U19 Allsvenskan", home: "Alpha U19", away: "Beta U19", posts: 0 },
    { league: "Honduras Reserve League", home: "Alpha Reserves", away: "Beta Reserves", posts: 0 },
    { league: "UEFA Youth League", home: "Alpha", away: "Beta", posts: 0 },
  ];
  for (const c of cases) {
    const net = mockNet({ feed: [] });
    const env = makeEnv();
    await webhook(worker, env, card({ header: "💰  Over 1.5 Value", league: c.league, home: c.home, away: c.away, score: "1-0", target: "Goal", minute: 58, pre: "3.0", live: "2.5" }));
    await cron(worker, env);
    assert.equal(premiumPosts(net).length, c.posts, JSON.stringify(c));
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
  assert.equal(r.finalGoals, null, "final score not known yet");
  // The won tip stays watched (only for the final score), not counted as open.
  assert.equal(tracked(env).length, 1);
  assert.ok(tracked(env)[0].settledKey);
  const open = await (await admin(worker, env, "/admin/api/results?days=7")).json();
  assert.equal(open.open.length, 0);
});

test("final score: logged when the match is gone after 85', for won and lost tips", async () => {
  const net = mockNet({ feed: [] });
  const env = makeEnv();
  await webhook(worker, env, card());
  await webhook(worker, env, card({ home: "Gamma", away: "Delta" }));
  await cron(worker, env);
  net.feed = [
    { id: "m", h: "Alpha FC", a: "Beta FC", minute: "80", hg: "3", ag: "0", sonGolDakikasi: "71" },
    { id: "n", h: "Gamma", a: "Delta", minute: "86", hg: "2", ag: "0" },
  ];
  await cron(worker, env);
  net.feed[0] = { id: "m", h: "Alpha FC", a: "Beta FC", minute: "90", hg: "4", ag: "1", sonGolDakikasi: "89" };
  await cron(worker, env);
  assert.equal(net.sent.filter((m) => m.method === "editMessageText").length, 1, "won tip marked once, not again on later goals");
  net.feed = [];
  const realNow = Date.now;
  try {
    await cron(worker, env); // both gone: grace period starts
    Date.now = () => realNow() + 11 * 60e3;
    await cron(worker, env);
  } finally { Date.now = realNow; }
  const byHome = Object.fromEntries(results(env).map((r) => [r.home, r]));
  assert.equal(byHome["Alpha FC"].result, "won");
  assert.equal(byHome["Alpha FC"].finalGoals, 5);
  assert.equal(byHome["Gamma"].result, "lost");
  assert.equal(byHome["Gamma"].finalGoals, 2);
  assert.equal(tracked(env).length, 0);
  const csv = await (await admin(worker, env, "/admin/api/results-csv?days=7")).text();
  assert.ok(csv.split("\n")[0].includes(",finalGoals,"));
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

test("logo: favicon is served as SVG and every public page links it and shows the speed wordmark", async () => {
  mockNet({ feed: [] });
  const env = makeEnv({ IMPRESSUM_NAME: "Max Muster", IMPRESSUM_ADDRESS: "Str. 1|12345 Ort" });
  const fav = await worker.fetch(new Request("https://moneybag-signals.com/favicon.svg"), env, {});
  assert.equal(fav.status, 200);
  assert.equal(fav.headers.get("Content-Type"), "image/svg+xml");
  assert.match(await fav.text(), /^<svg[\s\S]*<\/svg>$/);
  for (const path of ["/", "/ergebnisse", "/impressum", "/agb", "/datenschutz", "/?t=" + "a".repeat(32)]) {
    const html = await (await worker.fetch(new Request("https://moneybag-signals.com" + path), env, {})).text();
    assert.match(html, /<link rel="icon" href="\/favicon.svg"/, path);
    assert.match(html, /class="logo"[^>]*><i><\/i>MONEY<span>BAG<\/span>/, path);
    assert.doesNotMatch(html, /💰 MONEY/, path);
    if (path === "/") assert.match(html, /<h1>Analysen<br>statt <b>Gefühl.<\/b><\/h1>/);
  }
});

test("seo: start page and results page carry link-preview tags, the preview image is public", async () => {
  mockNet({ feed: [] });
  const env = makeEnv({ ASSETS: { fetch: (req) => new Response(new URL(req.url).pathname === "/og.png" ? "PNG" : "tool") } });
  const home = await (await worker.fetch(new Request("https://moneybag-signals.com/"), env, {})).text();
  assert.match(home, /<meta property="og:image" content="https:\/\/moneybag-signals.com\/og.png">/);
  assert.match(home, /<meta property="og:url" content="https:\/\/moneybag-signals.com\/">/);
  const ld = JSON.parse(home.match(/<script type="application\/ld\+json">(.*?)<\/script>/)[1]);
  assert.equal(ld["@graph"][0].url, "https://moneybag-signals.com/");
  const res = await (await worker.fetch(new Request("https://moneybag-signals.com/ergebnisse"), env, {})).text();
  assert.match(res, /og:url" content="https:\/\/moneybag-signals.com\/ergebnisse"/);
  const img = await worker.fetch(new Request("https://moneybag-signals.com/og.png"), env, {});
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("Content-Type"), "image/png");
  assert.equal(await img.text(), "PNG");
});

test("start page: shows the weekly own analysis (Daten der Woche) with bars and data basis", async () => {
  mockNet({ feed: [] });
  const html = await (await worker.fetch(new Request("https://moneybag-signals.com/"), makeEnv(), {})).text();
  assert.match(html, /<h2 id="daten">Daten der Woche<\/h2>/);
  assert.equal((html.match(/<div class="r( top)?">/g) || []).length, 4);
  assert.match(html, /77 %<\/span>/);
  assert.match(html, /eigene Auswertung/);
});

test("videos page: 15 MoneyBag videos from our own assets, byte ranges for Safari, no Torminute name", async () => {
  mockNet({ feed: [] });
  const env = makeEnv({ ASSETS: { fetch: () => new Response("0123456789") } });
  const html = await (await worker.fetch(new Request("https://moneybag-signals.com/videos"), env, {})).text();
  assert.equal((html.match(/<video /g) || []).length, 15);
  assert.doesNotMatch(html, /torminute|youtube|tiktok/i);
  const v = await worker.fetch(new Request("https://moneybag-signals.com/videos/jugend.mp4", { headers: { Range: "bytes=2-4" } }), env, {});
  assert.equal(v.status, 206);
  assert.equal(v.headers.get("Content-Type"), "video/mp4");
  assert.equal(v.headers.get("Content-Range"), "bytes 2-4/10");
  assert.equal(await v.text(), "234");
  const full = await worker.fetch(new Request("https://moneybag-signals.com/videos/jugend.mp4"), env, {});
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("Accept-Ranges"), "bytes");
  const tail = await worker.fetch(new Request("https://moneybag-signals.com/videos/jugend.mp4", { headers: { Range: "bytes=-3" } }), env, {});
  assert.equal(await tail.text(), "789");
  const sm = await (await worker.fetch(new Request("https://moneybag-signals.com/sitemap.xml"), env, {})).text();
  assert.match(sm, /\/videos<\/loc>/);
});

test("start page: visitors without a link get the public page with live numbers, a bad link still gets the access page", async () => {
  mockNet({ feed: [] });
  const env = makeEnv();
  seedResults(env, 10, 0);
  const res = await worker.fetch(new Request("https://moneybag-signals.com/"), env, {});
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /20 € \/ Monat/);
  assert.match(html, /24 Stunden kostenlos testen/);
  assert.match(html, /<svg viewBox="0 0 700 200"/);
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

test("contact API trial kind (old start page form): a Telegram name is enough, the request reaches the owner", async () => {
  const net = mockNet({ feed: [] });
  const env = makeEnv();
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

test("partner page: marked as advertising, rules, join form reaches the owner, bad channel links are refused", async () => {
  const net = mockNet({ feed: [] });
  const env = makeEnv();
  const html = await (await worker.fetch(new Request("https://moneybag-signals.com/partner"), env, {})).text();
  assert.match(html, /Werbung/);
  assert.match(html, /Gewinne <b>und<\/b> Verluste/);
  assert.match(html, /Warum dieses Netzwerk wichtig ist/);
  assert.match(html, /id="partner"/);
  for (const [, js] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Function(js);
  const post = (body, ip) => worker.fetch(new Request("https://x/api/contact", { method: "POST", headers: { "CF-Connecting-IP": ip }, body: JSON.stringify(body) }), env, {});
  const base = { kind: "partner", name: "Max", telegram: "@max_muster", message: "Statistik-Tipps zur 2. Liga" };
  assert.equal((await post({ ...base, channel: "https://evil.example/x" }, "1")).status, 400);
  assert.equal((await post({ ...base, channel: "t.me/tippkanal", message: "" }, "2")).status, 400);
  assert.equal((await post({ ...base, channel: "t.me/tippkanal", telegram: "" }, "3")).status, 400);
  const ok = await post({ ...base, channel: "@tippkanal" }, "4");
  assert.equal(ok.status, 200);
  const msg = net.sent.find((m) => m.chat_id === "777");
  assert.match(msg.text, /Partner-Anfrage/);
  assert.match(msg.text, /Kanal: https:\/\/t\.me\/tippkanal/);
  assert.match(msg.text, /Beschreibung: Statistik-Tipps/);
  const land = await (await worker.fetch(new Request("https://x/"), env, {})).text();
  assert.match(land, /href="\/partner"/);
  const sm = await (await worker.fetch(new Request("https://moneybag-signals.com/sitemap.xml"), env, {})).text();
  assert.match(sm, /\/partner<\/loc>/);
  assert.equal((await worker.fetch(new Request("https://x/partner/unknown.png"), env, {})).status, 403, "only listed banners are served");
});

test("menu: every public page has the fold-out menu with all main links", async () => {
  mockNet({ feed: [] });
  const env = makeEnv({ IMPRESSUM_NAME: "Max", IMPRESSUM_ADDRESS: "Str. 1|12345 Ort" });
  for (const path of ["/", "/ergebnisse", "/videos", "/partner", "/impressum", "/datenschutz", "/?t=" + "0".repeat(32)]) {
    const html = await (await worker.fetch(new Request("https://moneybag-signals.com" + path), env, {})).text();
    assert.match(html, /<details class="mnav">/, path);
    for (const href of ["/ergebnisse", "/videos", "/partner", "/#test", "/#daten", "/#faq"]) assert.ok(html.includes(`<a href="${href}" onclick`), `${path} → ${href}`);
  }
  const land = await (await worker.fetch(new Request("https://moneybag-signals.com/"), env, {})).text();
  for (const id of ["daten", "so", "faq", "preis", "test"]) assert.match(land, new RegExp(`id="${id}"`));
});

test("admin page: empty or wrong password gives a clear German hint instead of a bare 'unauthorized'", async () => {
  mockNet({ feed: [] });
  const html = await (await worker.fetch(new Request("https://x/admin"), makeEnv(), {})).text();
  assert.match(html, /Bitte oben zuerst das Admin-Passwort eintragen/);
  assert.match(html, /Passwort falsch/);
});

test("admin weekly image: drawn in the magazine design (speed logo, black/red bars, results link)", async () => {
  mockNet({ feed: [] });
  const html = await (await worker.fetch(new Request("https://x/admin"), makeEnv(), {})).text();
  for (const want of ["WOCHENBILANZ", "NACH STUFE", "Schwarz = Treffer, Rot = verloren", "moneybag-signals.com/ergebnisse"]) assert.ok(html.includes(want), want);
});

test("daily report: reminds the owner to fill voids from a CSV once 10+ tips of the week are ungewertet", async () => {
  const realDay = Date.prototype.getUTCDay;
  const run = async (voids) => {
    const net = mockNet({ feed: [] });
    const env = makeEnv();
    const now = Date.now();
    for (let i = 0; i < voids; i++) {
      const r = { tier: "premium", home: "H" + i, away: "A" + i, line: 2.5, minute: 60, units: 1, result: "void",
        postedAt: new Date(now - (10 + i) * 3600e3).toISOString(), settledAt: new Date(now - (6 + i) * 3600e3).toISOString() };
      env.ACCESS_KV.store.set(`result:${now - i}:${i}`, JSON.stringify(r));
      env.ACCESS_KV.meta.set(`result:${now - i}:${i}`, r);
    }
    Date.prototype.getUTCDay = () => 3;
    try { await cron(worker, env, "0 7 * * *"); } finally { Date.prototype.getUTCDay = realDay; }
    return net.sent.find((m) => m.chat_id === "777").text;
  };
  assert.doesNotMatch(await run(9), /Unklare Ergebnisse nachtragen/);
  const text = await run(10);
  assert.match(text, /10 Tipps der letzten 7 Tage sind noch ungewertet/);
  assert.match(text, /Unklare Ergebnisse nachtragen/);
});

test("admin results CSV: last 30 days as a file with quote, market and wait columns, password needed", async () => {
  mockNet({ feed: [] });
  const env = makeEnv();
  const now = Date.now();
  const r = { tier: "o15", home: "Alpha, FC", away: "Beta", line: 1.5, minute: 60, result: "won", resultMinute: 75, units: 0.5,
    minQuote: 1.32, quote: 1.25, quoteEstimated: true, betPlaced: false, profit: null, marketP: 0.78,
    wait: { entry: 71, bet: true, profit: 0.2 }, postedAt: new Date(now - 3600e3).toISOString(), settledAt: new Date(now).toISOString() };
  env.ACCESS_KV.store.set(`result:${now}:x`, JSON.stringify(r));
  env.ACCESS_KV.meta.set(`result:${now}:x`, r);
  assert.equal((await admin(worker, env, "/admin/api/results-csv?days=30", { headers: { Authorization: "Bearer falsch" } })).status, 401);
  const csv = await (await admin(worker, env, "/admin/api/results-csv?days=30")).text();
  const [head, row] = csv.trim().split("\n");
  assert.match(head, /^postedAt,settledAt,tier,home,away,line,minute,result/);
  assert.match(head, /marketP,waitEntry,waitBet,waitProfit/);
  assert.match(row, /,o15,"Alpha, FC",Beta,1.5,60,won,75,0.5,1.32,1.25,true,false,,0.78,71,true,0.2,/);
  const html = await (await worker.fetch(new Request("https://x/admin"), env, {})).text();
  assert.match(html, /CSV speichern \(30 Tage\)/);
});

test("automatic 24 h trial: start page button opens the bot, /start test gives invite + tool link once, removed after 24 h unless kept", async () => {
  const net = mockNet({ feed: [] });
  const env = makeEnv();
  const land = await (await worker.fetch(new Request("https://moneybag-signals.com/"), env, {})).text();
  assert.match(land, /href="\/test-starten"/);
  for (const [, js] of land.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Function(js);
  const go = await worker.fetch(new Request("https://moneybag-signals.com/test-starten"), env, {});
  assert.equal(go.status, 302);
  assert.equal(go.headers.get("location"), "https://t.me/MoneyBagTestBot?start=test");
  const dm = (id, text) => worker.fetch(new Request("https://moneybag-signals.com/telegram-webhook", {
    method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": "s" },
    body: JSON.stringify({ message: { chat: { id, type: "private" }, from: { id, username: "tester" + id }, text } }),
  }), env, {});
  await dm(4242, "/start test");
  const toUser = net.sent.filter((m) => m.chat_id === 4242 && m.method === "sendMessage");
  assert.equal(toUser.length, 1);
  assert.match(toUser[0].text, /https:\/\/t\.me\/\+trial/);
  const token = toUser[0].text.match(/\?t=([0-9a-f]{32})/)[1];
  const rec = JSON.parse(env.ACCESS_KV.store.get(token));
  assert.equal(rec.status, "trial");
  assert.ok(Math.abs(rec.expiresAt - Date.now() - 24 * 3600e3) < 60e3);
  const invite = net.sent.find((m) => m.method === "createChatInviteLink");
  assert.equal(invite.member_limit, 1);
  assert.ok(net.sent.some((m) => m.chat_id === "777" && /Automatischer 24h-Test.*ID 4242/.test(m.text)));
  await dm(4242, "/start test");
  assert.match(net.sent.filter((m) => m.chat_id === 4242).pop().text, /schon einen 24-Stunden-Test/);
  assert.equal(net.sent.filter((m) => m.method === "createChatInviteLink").length, 1, "one trial per person");
  // second user, kept by the owner
  await dm(5151, "/start test");
  await dm(777, "/behalten 5151");
  assert.match(net.sent.filter((m) => m.chat_id === 777).pop().text, /bleibt im Premium-Kanal/);
  // 25 h later: 4242 is removed, 5151 stays
  const realNow = Date.now;
  Date.now = () => realNow() + 25 * 3600e3;
  const realMin = Date.prototype.getUTCMinutes;
  Date.prototype.getUTCMinutes = () => 10;
  try { await cron(worker, env); } finally { Date.now = realNow; Date.prototype.getUTCMinutes = realMin; }
  const bans = net.sent.filter((m) => m.method === "banChatMember").map((m) => m.user_id);
  assert.deepEqual(bans, [4242]);
  assert.ok(net.sent.some((m) => m.method === "unbanChatMember" && m.user_id === 4242));
  assert.match(net.sent.filter((m) => m.chat_id === "4242").pop().text, /Test ist vorbei/);
});

test("admin API-Football check: no key, key with plan and calls, password needed", async () => {
  mockNet({ feed: [], apiLive: [{}, {}, {}] });
  let env = makeEnv();
  assert.equal((await (await admin(worker, env, "/admin/api/apifootball-status")).json()).key, false);
  env = makeEnv({ APIFOOTBALL_KEY: "k" });
  const d = await (await admin(worker, env, "/admin/api/apifootball-status")).json();
  assert.equal(d.ok, true);
  assert.equal(d.plan, "Pro");
  assert.equal(d.limit, 7500);
  assert.equal(d.live, 3);
  assert.equal(d.perMin, "300", "per-minute limit from the response headers");
  assert.equal((await admin(worker, env, "/admin/api/apifootball-status", { headers: { Authorization: "Bearer wrong" } })).status, 401);
  const html = await (await worker.fetch(new Request("https://x/admin"), env, {})).text();
  assert.ok(html.includes("API-Football prüfen"));
});

async function at(ms, fn) {
  const realNow = Date.now;
  Date.now = () => realNow() + ms;
  try { return await fn(); } finally { Date.now = realNow; }
}

test("API-Football: tip missing from the guest feed is checked, settled with the exact goal minute and the final score", async () => {
  const net = mockNet({ feed: [] });
  const env = makeEnv({ APIFOOTBALL_KEY: "k" });
  await webhook(worker, env, card({ home: "Drøbak/Frogn", away: "Ørn Horten" }));
  net.apiLive = [afFix({ id: 77, home: "Drobak-Frogn", away: "Orn Horten", minute: 58, goals: [20, 41] })];
  await at(130e3, () => cron(worker, env));
  assert.equal(premiumPosts(net).length, 1, "posted after the API check");
  net.apiLive = [afFix({ id: 77, home: "Drobak-Frogn", away: "Orn Horten", minute: 74, gh: 3, goals: [20, 41, 73] })];
  await at(20 * 60e3, () => cron(worker, env));
  let r = results(env)[0];
  assert.equal(r.result, "won");
  assert.equal(r.resultMinute, 73);
  assert.ok(net.sent.find((m) => m.method === "editMessageText").text.startsWith("✅ WIN – Tor in Minute 73'"));
  assert.equal(tracked(env)[0].afId, 77);
  // Full time: gone from the live list, looked up by id.
  net.apiLive = [];
  net.apiById = { 77: afFix({ id: 77, home: "Drobak-Frogn", away: "Orn Horten", status: "FT", minute: 90, gh: 3, ga: 1, goals: [20, 41, 73, 88] }) };
  await at(50 * 60e3, () => cron(worker, env));
  r = results(env)[0];
  assert.equal(r.finalGoals, 4);
  assert.equal(tracked(env).length, 0);
});

test("API-Football: a match never seen live is settled from the day list instead of void", async () => {
  const net = mockNet({ feed: [] });
  const env = makeEnv({ APIFOOTBALL_KEY: "k" });
  await webhook(worker, env, card());
  net.apiLive = [afFix({ id: 5, home: "Alpha FC", away: "Beta FC", minute: 57 })];
  await at(130e3, () => cron(worker, env));
  assert.equal(premiumPosts(net).length, 1);
  net.apiLive = [];
  await at(30 * 60e3, () => cron(worker, env)); // not found anywhere yet, too early for the day list
  assert.equal(net.dayCalls || 0, 0);
  // The fixture id from the check is stored; drop it to test the day list (tips that were never found live).
  const tr = tracked(env); assert.equal(tr[0].afId, 5); delete tr[0].afId; env.ACCESS_KV.store.set("track:open", JSON.stringify(tr));
  net.apiDay = [afFix({ id: 5, home: "Alpha", away: "Beta", status: "FT", minute: 90, gh: 2, ga: 0, goals: [10, 30] })];
  await at(70 * 60e3, () => cron(worker, env));
  const r = results(env)[0];
  assert.equal(r.result, "lost");
  assert.equal(r.finalGoals, 2);
  assert.equal(net.dayCalls, 1);
  assert.ok(net.sent.find((m) => m.method === "editMessageText").text.startsWith("❌"));
});

test("API-Football: postponed match is void", async () => {
  const net = mockNet({ feed: [] });
  const env = makeEnv({ APIFOOTBALL_KEY: "k" });
  await webhook(worker, env, card());
  net.apiLive = [afFix({ id: 9, home: "Alpha FC", away: "Beta FC", minute: 57 })];
  await at(130e3, () => cron(worker, env));
  net.apiLive = [];
  net.apiById = { 9: afFix({ id: 9, home: "Alpha FC", away: "Beta FC", status: "ABD", minute: 70 }) };
  await at(20 * 60e3, () => cron(worker, env));
  assert.equal(results(env)[0].result, "void");
  assert.equal(tracked(env).length, 0);
});

test("API-Football via RapidAPI: RAPIDAPI_KEY is used first, with the RapidAPI host and key headers", async () => {
  const net = mockNet({ feed: [], apiLive: [{}] });
  const env = makeEnv({ RAPIDAPI_KEY: "r", APIFOOTBALL_KEY: "k" });
  const d = await (await admin(worker, env, "/admin/api/apifootball-status")).json();
  assert.equal(d.ok, true);
  assert.equal(d.via, "RapidAPI");
  assert.equal(d.live, 1);
  for (const [url, h] of net.apiUrls) {
    assert.ok(url.startsWith("https://api-football-v1.p.rapidapi.com/v3/"), url);
    assert.equal(h["x-rapidapi-key"], "r");
    assert.equal(h["x-rapidapi-host"], "api-football-v1.p.rapidapi.com");
  }
});

test("API-Football via own proxy server: URL, key and proxy secret", async () => {
  const net = mockNet({ feed: [], apiLive: [{}, {}] });
  const env = makeEnv({ APIFOOTBALL_KEY: "k", AF_PROXY_URL: "https://af.example.com/", AF_PROXY_SECRET: "geheim" });
  const d = await (await admin(worker, env, "/admin/api/apifootball-status")).json();
  assert.equal(d.via, "eigener Server");
  assert.equal(d.live, 2);
  for (const [url, h] of net.apiUrls) {
    assert.ok(url === "https://af.example.com/status" || url === "https://af.example.com/fixtures?live=all", url);
    assert.equal(h["x-apisports-key"], "k");
    assert.equal(h["x-proxy-secret"], "geheim");
  }
});

test("API-Football live odds: first prices, highest over, minute it reached 1.40 and the next lines are stored with the result", async () => {
  const net = mockNet({ feed: [] });
  const env = makeEnv({ APIFOOTBALL_KEY: "k" });
  await webhook(worker, env, card());
  net.apiLive = [afFix({ id: 31, home: "Alpha FC", away: "Beta FC", minute: 57, goals: [10, 30] })];
  net.apiOdds = [afOdds(31, { "2.5": [1.3, 3.4], "2.75": [1.55, 2.4], "3": [1.95, 1.85], "3.5": [2.9, 1.4], "5.5": [20, 1.01] })];
  await at(130e3, () => cron(worker, env));
  assert.equal(premiumPosts(net).length, 1);
  await at(140e3, () => cron(worker, env)); // first odds sighting
  net.apiLive = [afFix({ id: 31, home: "Alpha FC", away: "Beta FC", minute: 66, goals: [10, 30] })];
  net.apiOdds = [afOdds(31, { "2.5": [1.45, 2.6] })];
  await at(10 * 60e3, () => cron(worker, env));
  const ol = tracked(env)[0].ol;
  assert.equal(ol.m, 57);
  assert.deepEqual(Object.keys(ol.f).sort(), ["2.5", "2.75", "3", "3.5"], "lines from line - 0.5 to line + 1 only, no half-time bet");
  assert.equal(ol.mx, 1.45);
  assert.equal(ol.r140, 66);
  net.apiLive = [afFix({ id: 31, home: "Alpha FC", away: "Beta FC", minute: 71, gh: 3, goals: [10, 30, 70] })];
  await at(15 * 60e3, () => cron(worker, env));
  const r = results(env)[0];
  assert.equal(r.result, "won");
  assert.equal(r.oddsOver, 1.3);
  assert.equal(r.oddsUnder, 3.4);
  assert.equal(r.oddsMax, 1.45);
  assert.equal(r.oddsMaxMinute, 66);
  assert.equal(r.odds140Minute, 66);
  assert.equal(r.oddsQuarterOver, 1.55);
  assert.equal(r.oddsNextOver, 1.95);
  assert.equal(r.liveOdds, undefined, "full odds log not in the metadata");
  const key = [...env.ACCESS_KV.store.keys()].find((k) => k.startsWith("result:"));
  assert.ok(JSON.parse(env.ACCESS_KV.store.get(key)).liveOdds.f["3"], "full log in the value");
  const csv = await (await admin(worker, env, "/admin/api/results-csv?days=7")).text();
  assert.ok(csv.split("\n")[0].includes("oddsNextOver"));
});

test("own match archive: finished matches leave the live list, are fetched by id and stored per kickoff day", async () => {
  const net = mockNet({ feed: [] });
  const env = makeEnv({ APIFOOTBALL_KEY: "k" });
  net.apiLive = [afFix({ id: 1, minute: 80 }), afFix({ id: 2, minute: 30 })];
  await cron(worker, env); // nothing open: the archive still runs
  assert.deepEqual(JSON.parse(env.ACCESS_KV.store.get("af:prev")).ids, [1, 2]);
  net.apiLive = [afFix({ id: 2, minute: 31 })];
  net.apiById = { 1: afFix({ id: 1, status: "FT", minute: 90, gh: 3, ga: 1, goals: [12, 50, 88],
    extra: [{ type: "Card", detail: "Red Card", time: { elapsed: 60 }, team: { id: 20 } },
      { type: "Goal", detail: "Penalty", time: { elapsed: 90, extra: 3 }, team: { id: 20 } }] }) };
  await cron(worker, env);
  const day = JSON.parse(env.ACCESS_KV.store.get("afm:2026-11-01"));
  assert.equal(day.length, 1);
  assert.equal(day[0].ft, "3-1");
  assert.equal(day[0].lg, "Eliteserien");
  assert.equal(day[0].ev, "G12h,G50h,G88h,R60a,P90+3a");
  await cron(worker, env); // stored once only
  assert.equal(JSON.parse(env.ACCESS_KV.store.get("afm:2026-11-01")).length, 1);
  const csv = await (await admin(worker, env, "/admin/api/matches-csv?days=400")).text();
  assert.ok(csv.startsWith("fixtureId,kickoff,country,league"));
  assert.ok(csv.includes("Eliteserien") && csv.includes("G12h"));
  assert.equal((await admin(worker, env, "/admin/api/matches-csv", { headers: { Authorization: "Bearer wrong" } })).status, 401);
});

test("admin odds probe: live matches with over/under odds, example, open tips", async () => {
  mockNet({ feed: [], apiLive: [afFix({ id: 5 }), afFix({ id: 6 })], apiOdds: [afOdds(5, { "2.5": [1.8, 2.0] })] });
  const env = makeEnv({ APIFOOTBALL_KEY: "k" });
  const d = await (await admin(worker, env, "/admin/api/odds-probe")).json();
  assert.equal(d.ok, true);
  assert.equal(d.live, 2);
  assert.equal(d.withOu, 1);
  assert.deepEqual(Object.keys(d.sample.lines), ["2.5"]);
  const html = await (await worker.fetch(new Request("https://x/admin"), env, {})).text();
  assert.ok(html.includes("Quoten-Abdeckung prüfen") && html.includes("Spiele-Archiv CSV"));
});
