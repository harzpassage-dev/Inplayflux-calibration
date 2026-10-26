# Six start-page design drafts (owner request 26.10.: "mehr Grafik, erfrischend und seriös").
# Live numbers from moneybag-signals.com on 26.10.2026 morning. System fonts only (no external fonts: privacy policy).
DAYS=[("13.10.",14,20),("14.10.",13,20),("15.10.",12,14),("16.10.",10,11),("17.10.",47,58),("18.10.",47,62),("19.10.",13,17),
      ("20.10.",13,19),("21.10.",30,40),("22.10.",22,28),("23.10.",51,60),("24.10.",87,119),("25.10.",87,105)]
HC=(446,556); ALL=(580,750)
pct=lambda w,n: f"{w/n*100:.1f}".replace(".",",")+" %"

def bars(w,h,win,loss,label="#cbd5e1",rate=False,line=None):
    n=len(DAYS); bw=w/n*0.62; gap=w/n; mx=max(t for _,_,t in DAYS); out=[]
    pts=[]
    for i,(d,won,tot) in enumerate(DAYS):
        x=i*gap+(gap-bw)/2
        if rate:
            r=won/tot; hh=(r-0.4)/0.6*(h-30)
            out.append(f'<rect x="{x:.1f}" y="{h-20-hh:.1f}" width="{bw:.1f}" height="{hh:.1f}" rx="4" fill="{win}"/>')
            pts.append((x+bw/2,h-20-hh))
        else:
            hw=won/mx*(h-30); hl=(tot-won)/mx*(h-30)
            out.append(f'<rect x="{x:.1f}" y="{h-20-hw-hl:.1f}" width="{bw:.1f}" height="{hl:.1f}" rx="3" fill="{loss}"/>')
            out.append(f'<rect x="{x:.1f}" y="{h-20-hw:.1f}" width="{bw:.1f}" height="{hw:.1f}" rx="3" fill="{win}"/>')
        if i%2==0: out.append(f'<text x="{x+bw/2:.1f}" y="{h-4}" font-size="11" text-anchor="middle" fill="{label}">{d[:5]}</text>')
    if line and pts:
        out.append(f'<polyline points="{" ".join(f"{a:.1f},{b:.1f}" for a,b in pts)}" fill="none" stroke="{line}" stroke-width="3"/>')
    return f'<svg viewBox="0 0 {w} {h}" width="100%">{"".join(out)}</svg>'

def ring(size,frac,col,bg,txt,sub,txtcol="#fff",subcol="#cbd5e1",stroke=16):
    r=size/2-stroke; c=2*3.14159*r
    return (f'<svg viewBox="0 0 {size} {size}" width="{size}" height="{size}"><circle cx="{size/2}" cy="{size/2}" r="{r}" fill="none" stroke="{bg}" stroke-width="{stroke}"/>'
            f'<circle cx="{size/2}" cy="{size/2}" r="{r}" fill="none" stroke="{col}" stroke-width="{stroke}" stroke-linecap="round" stroke-dasharray="{c*frac:.1f} {c:.1f}" transform="rotate(-90 {size/2} {size/2})"/>'
            f'<text x="50%" y="48%" text-anchor="middle" font-size="{size/5.2:.0f}" font-weight="800" fill="{txtcol}">{txt}</text>'
            f'<text x="50%" y="64%" text-anchor="middle" font-size="{size/13:.0f}" fill="{subcol}">{sub}</text></svg>')

BASE='*{box-sizing:border-box;margin:0;padding:0}body{width:820px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Liberation Sans",sans-serif}'
hc=HC[0]/HC[1]; al=ALL[0]/ALL[1]
D={}

D[1]=("Stadion bei Nacht","dunkel, Flutlicht, Gold – Weiterentwicklung des jetzigen Looks",f'''<style>{BASE}
body{{background:#071226;color:#eef2fb}}.top{{background:radial-gradient(ellipse at 50% -20%,rgba(255,236,170,.35),transparent 60%),linear-gradient(#0d1f44,#071226);padding:28px 36px 40px}}
.logo{{font-weight:800;color:#f5c542;letter-spacing:2px}}h1{{font-size:44px;line-height:1.1;margin:26px 0 12px}}h1 b{{color:#f5c542}}p.l{{color:#a9b6d3;font-size:19px;max-width:620px}}
.row{{display:flex;gap:22px;align-items:center;margin-top:30px}}.btn{{background:#f5c542;color:#1a1300;font-weight:800;padding:14px 22px;border-radius:12px;display:inline-block}}.btn.o{{background:none;border:1px solid #f5c542;color:#f5c542}}
.panel{{margin:0 36px;background:#0f2148;border:1px solid #24396b;border-radius:20px;padding:26px;display:flex;gap:28px;align-items:center}}
.chart{{margin:22px 36px;background:#0f2148;border:1px solid #24396b;border-radius:20px;padding:20px}}.chart h3{{font-size:16px;color:#a9b6d3;margin-bottom:10px}}
.k{{font-size:15px;color:#a9b6d3}}.k b{{display:block;font-size:30px;color:#fff}}</style>
<div class="top"><div class="logo">💰 MONEYBAG</div><h1>Live-Fußballsignale mit <b>Datenmodell</b> – und jedes Ergebnis offen</h1>
<p class="l">Über 13.000 ausgewertete Live-Signale. Mindestquote, Einsatz, offene Bilanz.</p><div class="row"><span class="btn">🎁 24 h gratis testen</span><span class="btn o">📊 Alle Ergebnisse</span></div></div>
<div class="panel">{ring(200,hc,"#f5c542","#24396b",pct(*HC),"High Confidence")}<div><div class="k"><b>{HC[0]} von {HC[1]}</b>Signale getroffen</div><div class="k" style="margin-top:16px"><b>{pct(*ALL)}</b>alle Stufen, 30 Tage</div></div></div>
<div class="chart"><h3>Letzte 14 Tage · Grün = Treffer, Rot = verloren</h3>{bars(748,190,"#2ecc71","#ff6b5b","#a9b6d3")}</div>''')

D[2]=("Frischer Rasen","hell, Weiß + Rasengrün, Streifen wie ein frisch gemähter Platz",f'''<style>{BASE}
body{{background:#f6faf6;color:#12301d}}.top{{background:repeating-linear-gradient(90deg,#1f8a4c 0 60px,#239654 60px 120px);color:#fff;padding:30px 36px 70px;position:relative}}
.top:after{{content:"";position:absolute;left:0;right:0;bottom:-1px;height:40px;background:#f6faf6;border-radius:40px 40px 0 0}}
.logo{{font-weight:800;font-size:20px}}h1{{font-size:44px;line-height:1.1;margin:24px 0 12px;max-width:640px}}p.l{{font-size:19px;opacity:.95;max-width:600px}}
.btn{{display:inline-block;background:#fff;color:#1f8a4c;font-weight:800;padding:14px 22px;border-radius:999px;margin:24px 10px 0 0}}.btn.o{{background:none;border:2px solid #fff;color:#fff}}
.cards{{display:flex;gap:16px;margin:-10px 36px 0;position:relative;z-index:2}}.c{{flex:1;background:#fff;border-radius:18px;padding:20px;box-shadow:0 8px 24px rgba(20,60,30,.08);text-align:center}}
.c b{{display:block;font-size:34px;color:#1f8a4c}}.c span{{font-size:14px;color:#5b7363}}
.chart{{margin:22px 36px;background:#fff;border-radius:18px;padding:20px;box-shadow:0 8px 24px rgba(20,60,30,.08)}}.chart h3{{font-size:16px;color:#5b7363;margin-bottom:8px}}</style>
<div class="top"><div class="logo">⚽ MoneyBag</div><h1>Statistik statt Bauchgefühl.</h1><p class="l">Live-Signale aus über 13.000 ausgewerteten Spielszenen – jeder Treffer und jeder Fehlgriff steht öffentlich da.</p>
<span class="btn">🎁 24 h gratis testen</span><span class="btn o">Ergebnisse ansehen</span></div>
<div class="cards"><div class="c"><b>{pct(*HC)}</b><span>🔥 High Confidence</span></div><div class="c"><b>{ALL[1]}</b><span>Signale ausgewertet</span></div><div class="c"><b>20 €</b><span>pro Monat, kündbar</span></div></div>
<div class="chart"><h3>Trefferquote pro Tag (Linie) · letzte 14 Tage</h3>{bars(748,200,"#bfe6cc","#fff","#5b7363",rate=True,line="#1f8a4c")}</div>''')

D[3]=("Anzeigetafel","Stadion-Scoreboard: schwarz, LED-Orange, große Ziffern",f'''<style>{BASE}
body{{background:#0b0b0d;color:#f2f2f2}}.top{{padding:30px 36px}}.logo{{font-weight:900;letter-spacing:4px;color:#ff9f1a}}
.board{{margin-top:22px;background:#151518;border:3px solid #2a2a30;border-radius:18px;padding:22px;display:grid;grid-template-columns:1fr 1fr;gap:18px}}
.cell{{background:#000;border-radius:12px;padding:16px;text-align:center;box-shadow:inset 0 0 0 1px #222}}.cell b{{display:block;font:800 52px/1 "DejaVu Sans Mono",ui-monospace,monospace;color:#ff9f1a;text-shadow:0 0 14px rgba(255,159,26,.6)}}
.cell span{{font-size:13px;letter-spacing:2px;color:#9a9aa3;text-transform:uppercase}}h1{{font-size:40px;line-height:1.1;margin:28px 0 10px}}p.l{{color:#b6b6bd;font-size:18px}}
.btn{{display:inline-block;background:#ff9f1a;color:#000;font-weight:900;padding:14px 22px;border-radius:10px;margin:22px 10px 0 0;letter-spacing:1px}}.btn.o{{background:none;border:2px solid #ff9f1a;color:#ff9f1a}}
.chart{{margin:6px 36px 30px;background:#151518;border:3px solid #2a2a30;border-radius:18px;padding:18px}}.chart h3{{font-size:13px;letter-spacing:2px;color:#9a9aa3;margin-bottom:8px}}</style>
<div class="top"><div class="logo">💰 MONEYBAG · LIVE</div><div class="board"><div class="cell"><b>{pct(*HC).replace(" %","%")}</b><span>High Confidence</span></div><div class="cell"><b>{HC[0]}/{HC[1]}</b><span>Treffer</span></div><div class="cell"><b>{pct(*ALL).replace(" %","%")}</b><span>alle Stufen</span></div><div class="cell"><b>13.000+</b><span>Signale im Modell</span></div></div>
<h1>Der Spielstand unserer Signale – live und ungeschönt.</h1><p class="l">Jedes Ergebnis wird automatisch eingetragen. Treffer und Verluste.</p><span class="btn">24 H GRATIS TESTEN</span><span class="btn o">ERGEBNISSE</span></div>
<div class="chart"><h3>LETZTE 14 TAGE</h3>{bars(742,190,"#ff9f1a","#5a2a2a","#9a9aa3")}</div>''')

D[4]=("Taktiktafel","Trainer-Tafel: dunkelgrün, Kreidelinien, Pfeile – erklärt das System wie eine Taktik",f'''<style>{BASE}
body{{background:#173d2c;color:#f4f1e6}}.top{{padding:30px 36px;background:radial-gradient(circle at 70% 30%,rgba(255,255,255,.06),transparent 50%)}}.logo{{font-weight:800;letter-spacing:2px}}
h1{{font-size:42px;line-height:1.12;margin:22px 0 10px;font-family:"Comic Sans MS","Chalkboard SE","Segoe Print",cursive,sans-serif}}p.l{{font-size:18px;color:#d9e6dc}}
.steps{{display:flex;gap:12px;margin:26px 0 0;align-items:center}}.s{{flex:1;border:2px dashed rgba(244,241,230,.6);border-radius:16px;padding:16px;text-align:center;font-weight:700}}.s i{{display:block;font-style:normal;font-size:30px}}.arr{{font-size:28px;opacity:.8}}
.btn{{display:inline-block;background:#f4f1e6;color:#173d2c;font-weight:800;padding:14px 22px;border-radius:12px;margin:24px 10px 0 0}}
.board{{margin:0 36px 30px;border:2px solid rgba(244,241,230,.5);border-radius:18px;padding:20px;display:flex;gap:24px;align-items:center}}.board h3{{font-size:15px;color:#d9e6dc;margin-bottom:6px}}</style>
<div class="top"><div class="logo">💰 MoneyBag</div><h1>Unser Spielzug: erst rechnen, dann posten.</h1><p class="l">Wie ein Trainer an der Tafel – jedes Signal läuft durch dieselben drei Schritte.</p>
<div class="steps"><div class="s"><i>📡</i>Live-Szene erkannt</div><div class="arr">➜</div><div class="s"><i>🧮</i>Modell prüft</div><div class="arr">➜</div><div class="s"><i>📢</i>nur starke Signale raus</div></div>
<span class="btn">🎁 24 h gratis testen</span></div>
<div class="board">{ring(170,hc,"#f4f1e6","rgba(244,241,230,.18)",pct(*HC),"High Confidence","#f4f1e6","#d9e6dc",12)}<div style="flex:1"><h3>Letzte 14 Tage</h3>{bars(500,160,"#f4f1e6","rgba(244,241,230,.25)","#d9e6dc")}</div></div>''')

D[5]=("Klar & vertrauenswürdig","hell, Weiß + ruhiges Blau, viel Luft, Vertrauens-Siegel – wirkt am seriösesten",f'''<style>{BASE}
body{{background:#f7f9fc;color:#0f1f3d}}.nav{{display:flex;justify-content:space-between;padding:22px 36px;font-weight:800}}.nav span{{font-weight:600;color:#4a5b7a;font-size:15px}}
.hero{{display:flex;gap:26px;align-items:center;padding:16px 36px 10px}}h1{{font-size:40px;line-height:1.12;margin-bottom:12px}}h1 b{{color:#2563eb}}p.l{{color:#4a5b7a;font-size:18px}}
.btn{{display:inline-block;background:#2563eb;color:#fff;font-weight:700;padding:14px 22px;border-radius:12px;margin:22px 10px 0 0}}.btn.o{{background:#fff;color:#2563eb;border:1px solid #c7d6f5}}
.badges{{display:flex;gap:12px;padding:20px 36px}}.b{{flex:1;background:#fff;border:1px solid #e3e9f3;border-radius:14px;padding:14px;font-size:14px;color:#4a5b7a}}.b b{{display:block;color:#0f1f3d;font-size:15px;margin-bottom:2px}}
.chart{{margin:6px 36px 30px;background:#fff;border:1px solid #e3e9f3;border-radius:18px;padding:20px}}.chart h3{{font-size:15px;color:#4a5b7a;margin-bottom:8px}}</style>
<div class="nav">💰 MoneyBag <span>Ergebnisse · Preis · FAQ</span></div>
<div class="hero"><div style="flex:1"><h1>Fußball-Signale, die man <b>nachprüfen</b> kann.</h1><p class="l">Datenmodell aus 13.000+ Live-Signalen. Jeder Tipp mit Mindestquote – und jedes Ergebnis öffentlich.</p><span class="btn">24 h kostenlos testen</span><span class="btn o">Ergebnisse</span></div>
<div>{ring(210,hc,"#2563eb","#e3e9f3",pct(*HC),"High Confidence","#0f1f3d","#4a5b7a",18)}</div></div>
<div class="badges"><div class="b"><b>✓ Offene Bilanz</b>Treffer und Verluste, nichts gelöscht</div><div class="b"><b>✓ Jede Woche geprüft</b>an neuen Spielen nachgerechnet</div><div class="b"><b>✓ Monatlich kündbar</b>20 €, per E-Mail</div></div>
<div class="chart"><h3>Signale der letzten 14 Tage</h3>{bars(748,180,"#2563eb","#f4b4b4","#4a5b7a")}</div>''')

D[6]=("Sport-Magazin","kräftig: Rot/Schwarz/Weiß, schräge Trikot-Streifen, große Schlagzeilen",f'''<style>{BASE}
body{{background:#fff;color:#111}}.top{{background:linear-gradient(115deg,#111 0 58%,#e0262f 58% 70%,#111 70%);color:#fff;padding:30px 36px 46px}}
.logo{{font-weight:900;letter-spacing:3px}}h1{{font-size:54px;line-height:.98;margin:22px 0 14px;text-transform:uppercase;font-weight:900;max-width:560px}}h1 b{{color:#ff4b52}}
p.l{{font-size:18px;color:#ddd;max-width:520px}}.btn{{display:inline-block;background:#e0262f;color:#fff;font-weight:900;padding:14px 22px;margin:22px 10px 0 0;text-transform:uppercase;letter-spacing:1px}}.btn.o{{background:#fff;color:#111}}
.nums{{display:flex;border-bottom:4px solid #111}}.n{{flex:1;padding:22px 26px;border-right:1px solid #ddd}}.n b{{display:block;font-size:44px;font-weight:900;color:#e0262f;line-height:1}}.n span{{font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:1px}}
.chart{{padding:22px 36px 30px}}.chart h3{{font-size:14px;font-weight:900;text-transform:uppercase;letter-spacing:2px;margin-bottom:8px}}</style>
<div class="top"><div class="logo">💰 MONEYBAG</div><h1>Zahlen<br>statt <b>Gefühl.</b></h1><p class="l">Live-Fußballsignale mit Datenmodell. Jedes Ergebnis öffentlich – Treffer wie Pleiten.</p><span class="btn">24 h gratis testen</span><span class="btn o">Ergebnisse</span></div>
<div class="nums"><div class="n"><b>{pct(*HC)}</b><span>High Confidence</span></div><div class="n"><b>{HC[0]}</b><span>Treffer</span></div><div class="n"><b>20 €</b><span>pro Monat</span></div></div>
<div class="chart"><h3>Die letzten 14 Tage</h3>{bars(748,190,"#111","#e0262f","#555")}</div>''')

for k,(name,desc,html) in D.items():
    open(f"design-{k}.html","w").write(f'<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Design {k} – {name}</title></head><body>{html}</body></html>')
open("designs.txt","w").write("\n".join(f"{k}|{n}|{d}" for k,(n,d,_) in D.items()))
