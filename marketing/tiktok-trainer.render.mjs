import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const html=process.env.HTML||path.join(path.dirname(fileURLToPath(import.meta.url)),"tiktok-trainer.video.html");
const dir=process.env.OUT_DIR||"/tmp/vid9";
fs.mkdirSync(dir+"/f",{recursive:true});
const b=await chromium.launch({executablePath:"/opt/pw-browsers/chromium-1194/chrome-linux/chrome"});
const p=await b.newPage({viewport:{width:1080,height:1920}});
const errs=[];p.on("pageerror",e=>errs.push(e.message));
await p.goto("file://"+html);
const only=process.argv[2]?process.argv[2].split(",").map(Number):null;
const fps=30,N=31*fps;
for(let i=0;i<N;i++){const t=i/fps;if(only&&!only.some(x=>Math.abs(x-t)<1e-6))continue;
 await p.evaluate(t=>render(t),t);
 await p.screenshot({path:only?`${dir}/prev_${t}.png`:`${dir}/f/${String(i).padStart(4,"0")}.jpg`,type:only?"png":"jpeg",quality:only?undefined:92});}
console.log("errors",errs);await b.close();
