// MoneyBag versions of the Torminute videos for moneybag-signals.com/videos (owner's choice 30.10.2026):
// same numbers, MoneyBag brand instead of "⚽ TORMINUTE", no @torminute and no comment calls, red/black look.
// Torminute itself stays separate (no MoneyBag on Torminute, no Torminute name on MoneyBag).
//   node moneybag-videos.mjs [slug ...]   → ../worker/public/videos/<slug>.mp4 + <slug>.jpg (720x1280, silent)
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "../worker/public/videos");
const tmp = process.env.TMP_DIR || "/tmp/mbvid";
fs.mkdirSync(out, { recursive: true });
const all = fs.readdirSync(here).filter((f) => /^tiktok-.*\.video\.html$/.test(f)).map((f) => f.slice(7, -11));
const slugs = process.argv.slice(2).length ? process.argv.slice(2) : all;
const CSS = `<style>
#bg{background:linear-gradient(115deg,#111 0 66%,#e0262f 66% 74%,#111 74%)!important}#pitch{opacity:.04!important}
.gold{color:#ff4b52!important}#prog{background:#e0262f!important}.tag{color:#ff4b52!important}
#brand{color:#fff!important;letter-spacing:-1px!important;font-style:italic;font-weight:900!important;font-size:52px!important}
#brand b{color:#ff4b52}#brand i{display:inline-block;width:64px;height:28px;margin-right:10px;vertical-align:2px;
background:linear-gradient(#ff4b52,#ff4b52) 12px 0/52px 5px no-repeat,linear-gradient(#ff4b52,#ff4b52) 0 11px/64px 5px no-repeat,linear-gradient(#ff4b52,#ff4b52) 20px 22px/44px 5px no-repeat}
</style>`;
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
for (const slug of slugs) {
  let html = fs.readFileSync(path.join(here, `tiktok-${slug}.video.html`), "utf8")
    .replace("⚽ TORMINUTE", "<i></i>MONEY<b>BAG</b>")
    .replace(/Folge <span class="gold">@torminute<\/span> ⚽📊/, "Mehr Daten: <span class=\"gold\">moneybag-signals.com</span>")
    .replace(/ (Schreib es|Ab) in die Kommentare!/g, "")
    .replace("</head>", CSS + "</head>");
  if (/torminute/i.test(html)) throw new Error(slug + ": Torminute left in the video");
  const dir = path.join(tmp, slug); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const src = path.join(here, `.mb-${slug}.html`); fs.writeFileSync(src, html);
  const p = await b.newPage({ viewport: { width: 1080, height: 1920 } });
  const errs = []; p.on("pageerror", (e) => errs.push(e.message));
  await p.goto("file://" + src);
  const T = await p.evaluate(() => typeof T === "number" ? T : 31);
  for (let i = 0; i < T * 30; i++) {
    await p.evaluate((t) => render(t), i / 30);
    await p.screenshot({ path: `${dir}/${String(i).padStart(4, "0")}.jpg`, type: "jpeg", quality: 85 });
  }
  await p.evaluate(() => render(2.5)); await p.screenshot({ path: `${dir}/poster.jpg`, type: "jpeg", quality: 80 });
  await p.close(); fs.rmSync(src);
  if (errs.length) throw new Error(slug + ": " + errs.join("; "));
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-framerate", "30", "-i", `${dir}/%04d.jpg`, "-vf", "scale=720:1280",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "27", "-preset", "slow", "-movflags", "+faststart", path.join(out, `${slug}.mp4`)]);
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", `${dir}/poster.jpg`, "-vf", "scale=360:640", "-q:v", "5", path.join(out, `${slug}.jpg`)]);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(slug, (fs.statSync(path.join(out, `${slug}.mp4`)).size / 1e6).toFixed(2), "MB");
}
await b.close();
