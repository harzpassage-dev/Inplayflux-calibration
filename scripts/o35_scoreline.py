#!/usr/bin/env python3
"""Over 3.5 cards (3 goals at the signal): hit rate and timing of the 4th goal per scoreline
(3:0, 0:3, 2:1, 1:2), plus half-time goal cards and Over 1.5 cards for the 21.10. report.

  python3 scripts/o35_scoreline.py data/*.csv
"""
import glob, sys
import numpy as np, pandas as pd

files = sys.argv[1:] or sorted(glob.glob("data/*.csv"))
d = pd.concat([pd.read_csv(f, dtype=str) for f in files], ignore_index=True)
c = lambda k: [x for x in d.columns if x.startswith(k)][0]
d = d.drop_duplicates([c("Tarih"), c("Maç"), c("Strateji"), c("Sinyal Dk")]).reset_index(drop=True)
res = d[c("Sonuç (")].astype(str)
d = d[res.str.contains("won|lost", case=False)].reset_index(drop=True)
num = lambda k: pd.to_numeric(d[c(k)].astype(str).str.replace("=", "").str.replace('"', ""), errors="coerce")
d["win"] = d[c("Sonuç (")].str.contains("won", case=False)
d["t"] = pd.to_datetime(d[c("Tarih")].str.extract(r"(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)")[0])
sc = d[c("Skor")].astype(str).str.extract(r"(\d+)\s*-\s*(\d+)").astype(float)
d["h"], d["a"] = sc[0], sc[1]
d["min"], d["rmin"] = num("Sinyal Dk"), num("Sonuç Dk")
d["sot"] = num("Şut İsabetli Ev") + num("Şut İsabetli Dep")
d["line"], d["htline"] = num("MÖ Gol Baremi"), num("MÖ İY Gol Baremi")
d["radar"] = num("Radar X")
oh, oa = num("KO Oran Ev"), num("KO Oran Dep")
d["favhome"] = oh < oa
target = d[c("Hedef")].astype(str)
mid = d["t"].min() + (d["t"].max() - d["t"].min()) / 2
A = d["t"] <= mid

def row(lab, m):
    n = int(m.sum())
    if not n:
        return f"  {lab:28s} n=0"
    w = d.loc[m, "win"]
    a, b = d.loc[m & A, "win"], d.loc[m & ~A, "win"]
    return (f"  {lab:28s} n={n:5d}  {w.mean()*100:5.1f}%   1. Hälfte {a.mean()*100 if len(a) else float('nan'):5.1f}% (n{len(a)})"
            f"   2. Hälfte {b.mean()*100 if len(b) else float('nan'):5.1f}% (n{len(b)})")

print(f"Zeitraum {d['t'].min():%d.%m.}–{d['t'].max():%d.%m.%Y}, Hälften getrennt bei {mid:%d.%m. %H:%M}")
o35 = (target == "Over 3.5") & (d["h"] + d["a"] == 3)
print(f"\n=== Over 3.5 (3 Tore beim Signal), alle {int(o35.sum())} Karten: {d.loc[o35,'win'].mean()*100:.1f}% ===")
for s in ["3-0", "0-3", "2-1", "1-2"]:
    hh, aa = map(int, s.split("-"))
    m = o35 & (d["h"] == hh) & (d["a"] == aa)
    print(row(f"Stand {hh}:{aa}", m))
    w = m & d["win"]
    g = d.loc[w, "rmin"]; wait = g - d.loc[w, "min"]
    if len(g):
        b = [(g <= 70).mean(), ((g > 70) & (g <= 80)).mean(), ((g > 80) & (g <= 90)).mean(), (g > 90).mean()]
        print(f"      4. Tor: bis 70' {b[0]*100:.0f}% · 71-80' {b[1]*100:.0f}% · 81-90' {b[2]*100:.0f}% · 90+' {b[3]*100:.0f}%"
              f" · Wartezeit Median {wait.median():.0f} min · Signal-Minute Median {d.loc[m,'min'].median():.0f}'")
print("\n  Klare Führung (3:0/0:3) vs. knapp (2:1/1:2):")
clear = o35 & ((d["h"] - d["a"]).abs() == 3)
close = o35 & ((d["h"] - d["a"]).abs() == 1)
print(row("3:0 / 0:3", clear)); print(row("2:1 / 1:2", close))
print("\n  Wer führt? (Favorit = niedrigere Anstoß-Quote)")
lead_home = d["h"] > d["a"]
favlead = (lead_home & d["favhome"]) | (~lead_home & ~d["favhome"])
print(row("Favorit führt", o35 & favlead)); print(row("Außenseiter führt", o35 & ~favlead))
print(row("2:1/1:2, Favorit führt", close & favlead)); print(row("2:1/1:2, Außenseiter führt", close & ~favlead))
print(row("3:0/0:3, Favorit führt", clear & favlead)); print(row("3:0/0:3, Außenseiter führt", clear & ~favlead))
print("\n  Signal-Minute:")
for lo, hi in [(0, 60), (61, 63), (64, 66), (67, 90)]:
    print(row(f"Minute {lo}-{hi}", o35 & (d["min"] >= lo) & (d["min"] <= hi)))
print("\n  Vorab-Torlinie:")
for lab, m in [("<= 2.75", d["line"] <= 2.75), ("3.0-3.25", (d["line"] >= 3) & (d["line"] <= 3.25)), (">= 3.5", d["line"] >= 3.5)]:
    print(row(lab, o35 & m))

ht = target == "HT Goal"
print(f"\n=== Halbzeit-Tor-Karten (Ziel: Tor vor der Pause), alle {int(ht.sum())}: {d.loc[ht,'win'].mean()*100:.1f}% ===")
for s in sorted(d.loc[ht, c("Strateji")].unique()):
    print(row(s.strip()[:28], ht & (d[c("Strateji")] == s)))
for lo, hi in [(0, 15), (16, 20), (21, 25), (26, 45)]:
    print(row(f"Minute {lo}-{hi}", ht & (d["min"] >= lo) & (d["min"] <= hi)))
for lab, m in [("HT-Linie <= 1.0", d["htline"] <= 1.0), ("HT-Linie 1.25", d["htline"] == 1.25), ("HT-Linie >= 1.5", d["htline"] >= 1.5)]:
    print(row(lab, ht & m))
for lab, m in [("0:0 beim Signal", (d["h"] + d["a"]) == 0), ("schon Tor(e)", (d["h"] + d["a"]) > 0)]:
    print(row(lab, ht & m))
print(row("HT-Linie>=1.5 & Min<=20", ht & (d["htline"] >= 1.5) & (d["min"] <= 20)))
print(row("HT-Linie>=1.5 & Radar>=350", ht & (d["htline"] >= 1.5) & (d["radar"] >= 350)))

o15 = (target.isin(["Over 1.5", "Goal"])) & (d["h"] + d["a"] == 1)
print(f"\n=== Over 1.5 (1 Tor beim Signal), alle {int(o15.sum())}: {d.loc[o15,'win'].mean()*100:.1f}% ===")
for lo, hi in [(0, 61), (62, 64), (65, 67), (68, 90)]:
    print(row(f"Minute {lo}-{hi}", o15 & (d["min"] >= lo) & (d["min"] <= hi)))
for lab, m in [("Vorab-Linie <= 2.5", d["line"] <= 2.5), ("2.75-3.0", (d["line"] >= 2.75) & (d["line"] <= 3)), (">= 3.25", d["line"] >= 3.25)]:
    print(row(lab, o15 & m))
print(row("Min<=61 & Linie>=2.75", o15 & (d["min"] <= 61) & (d["line"] >= 2.75)))
print(row("Min<=61 & Linie>=3.25", o15 & (d["min"] <= 61) & (d["line"] >= 3.25)))
after = d["t"] > pd.Timestamp("2026-10-17 20:16:00")
print(row("neu seit 17.10. abends", o15 & after))
print(row("neu: Min<=61 & Linie>=2.75", o15 & after & (d["min"] <= 61) & (d["line"] >= 2.75)))

print("\n=== Over 3.5 Kombinationen ===")
early = d["min"] <= 63
print(row("3:0/0:3 & Min<=63", clear & early))
print(row("2:1/1:2 & Min<=63", close & early))
print(row("3:0/0:3 & Min<=63 & Linie>=3", clear & early & (d["line"] >= 3)))
print(row("2:1/1:2 & Min<=63 & Linie>=3", close & early & (d["line"] >= 3)))
print(row("neu seit 17.10.: 3:0/0:3", clear & after))
print(row("neu seit 17.10.: 2:1/1:2", close & after))
