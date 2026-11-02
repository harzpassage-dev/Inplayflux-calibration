import { chromium } from "playwright";
const card = `💰 MoneyBag 2-0/0-2 → Over 2.5 New
🏆 Beispiel-Liga
⚽ Heim FC 2-0 Gast FC
🎯 Target: Over 2.5 Goals
⏱ 58' · ~32 min left · HT 1-0
📊 Shots 6 · 3 / 9 · 14 total
📡 Radar X: ■■■■ (432)
🎯 Strike Rate: 80% (721/899)
⚖️ O/U  3.5 → 2.5 📉   Over 1.42  Under 2.75`;
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const p = await b.newPage({ viewport: { width: 430, height: 900 }, deviceScaleFactor: 2 });
const errs = []; p.on("pageerror", (e) => errs.push(e.message)); p.on("console", m => { if (m.type()==="error") errs.push(m.text()); });
await p.goto("file:///home/user/Inplayflux-calibration/worker/public/index.html");
await p.waitForTimeout(500);
await p.fill("#raw-input", card);
await p.screenshot({ path: "s1.png", fullPage: false });
await p.click("#parse-btn"); await p.waitForTimeout(400);
const r = await p.evaluate(() => { const b = document.getElementById("parsed-section").getBoundingClientRect(); return { x: b.left, y: b.top + window.scrollY, w: b.width }; });
await p.screenshot({ path: "s2.png", clip: { x: r.x, y: r.y, width: r.w, height: 520 }, fullPage: true });
await p.click("#compute-btn"); await p.waitForTimeout(600);
await (await p.$("#results-section")).screenshot({ path: "s3.png" });
await (await p.$("#input-section")).screenshot({ path: "s1.png" });
await (await p.$("#edge-section")).screenshot({ path: "s4.png" });
await p.evaluate(() => window.scrollTo(0, 0));
await p.screenshot({ path: "s0.png" });
const ids = await p.$$eval("section", (s) => s.map((x) => x.id + ":" + (x.style.display) + ":" + x.offsetHeight));
console.log(ids, errs);
await b.close();
