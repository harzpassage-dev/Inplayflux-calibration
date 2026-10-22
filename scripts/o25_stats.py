#!/usr/bin/env python3
"""Over 2.5 (Karten bei 2 Toren): Trefferquote nach Vor-Spiel-Linie, Minute, Spielstand (2:0/1:1),
Schüssen aufs Tor, Radar, Strategie; einfache Regeln gegen das Modell (Schwelle 0,80) auf Hälften
und ungesehenen Tagen.

  python3 scripts/o25_stats.py data/*.csv
"""
import glob, json, os, sys
import numpy as np
import pandas as pd

files = sys.argv[1:] or sorted(glob.glob("data/*.csv"))
d = pd.concat([pd.read_csv(f, dtype=str) for f in files], ignore_index=True)
c = lambda k: [x for x in d.columns if x.startswith(k)][0]
d = d.drop_duplicates([c("Tarih"), c("Maç"), c("Strateji"), c("Sinyal Dk")]).reset_index(drop=True)
d = d[d[c("Sonuç (")].astype(str).str.contains("won|lost", case=False)].reset_index(drop=True)
d = d[~d[c("Hedef")].astype(str).str.match(r"\s*HT")].reset_index(drop=True)
num = lambda k: pd.to_numeric(d[c(k)].astype(str).str.replace("=", "").str.replace('"', ""), errors="coerce")
sc = d[c("Skor")].astype(str).str.extract(r"(\d+)\s*-\s*(\d+)").astype(float)
d["h"], d["a"] = sc[0], sc[1]
d["g"] = d.h + d.a
d["win"] = d[c("Sonuç (")].str.contains("won", case=False)
d["t"] = d[c("Tarih")].str.extract(r"(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)")[0]
d["min"], d["line"], d["radar"] = num("Sinyal Dk"), num("MÖ Gol Baremi"), num("Radar X")
d["sot"] = num("Şut İsabetli Ev") + num("Şut İsabetli Dep")
d["strat"] = d[c("Strateji")].str.strip()
oh, oa = num("KO Oran Ev"), num("KO Oran Dep")
d["favlead"] = np.where(oh < oa, d.h - d.a, d.a - d.h)
o = d[d.g == 2].copy()
# Live model (worker CONFIDENCE_MODELS 2.5, from calibration/rules.json)
m = json.load(open(os.path.join(os.path.dirname(__file__), "..", "calibration", "rules.json")))["live_confidence_models"]["2.5"]
X = o[["min", "sot", "radar", "line"]].to_numpy(float)
z = ((X - np.array(m["mean"])) / np.array(m["std"])) @ np.array(m["coef"]) + m["intercept"]
o["proba"] = 1 / (1 + np.exp(-z))
mid, NEW = "2026-10-01", "2026-10-17 20:16:00"
A, B, N = o.t < mid, o.t >= mid, o.t > NEW

def row(lab, msk):
    msk = msk.fillna(False)
    f = lambda s: f"{s.mean()*100:5.1f}% (n{len(s)})" if len(s) else "   –      "
    return (f"  {lab:34s} n={int(msk.sum()):5d} {o.loc[msk,'win'].mean()*100:5.1f}% | vor 1.10. {f(o.loc[msk & A,'win'])}"
            f" | ab 1.10. {f(o.loc[msk & B,'win'])} | neu ab 17.10. {f(o.loc[msk & N,'win'])}")

print(f"Over 2.5: {len(o)} Karten, {o.t.min()[:10]}–{o.t.max()[:10]}")
print(row("ALLE", o.win.notna()))
print(row("Modell >= 0,80 (heute im Einsatz)", o.proba >= 0.80))
print("\n-- Vor-Spiel-Linie")
for lab, msk in [("<= 2.5", o.line <= 2.5), ("2.75-3.0", o.line.between(2.75, 3.0)), ("3.25-3.5", o.line.between(3.25, 3.5)), (">= 3.75", o.line >= 3.75)]:
    print(row(lab, msk))
print("\n-- Minute")
for lo, hi in [(0, 57), (58, 60), (61, 63), (64, 66), (67, 99)]:
    print(row(f"{lo}-{hi}", o["min"].between(lo, hi)))
print("\n-- Spielstand")
print(row("1:1", (o.h == 1) & (o.a == 1)))
print(row("2:0 / 0:2", (o.h - o.a).abs() == 2))
print(row("Favorit führt 2:0", o.favlead == 2))
print(row("Außenseiter führt 2:0", o.favlead == -2))
print("\n-- Schüsse aufs Tor")
for lab, msk in [("0-4", o.sot <= 4), ("5-7", o.sot.between(5, 7)), ("8-10", o.sot.between(8, 10)), ("11+", o.sot >= 11)]:
    print(row(lab, msk))
print("\n-- Radar X")
for lab, msk in [("< 300", o.radar < 300), ("300-399", o.radar.between(300, 399)), ("400+", o.radar >= 400)]:
    print(row(lab, msk))
print("\n-- Strategien (>= 100 Karten)")
for s_, n in o.strat.value_counts().items():
    if n >= 100:
        print(row(s_[:34], o.strat == s_))
print("\n-- Einfache Regeln")
rules = {
    "Linie >= 3.25": o.line >= 3.25,
    "Linie >= 3 & Min <= 60": (o.line >= 3) & (o["min"] <= 60),
    "Linie >= 3.25 & Min <= 63": (o.line >= 3.25) & (o["min"] <= 63),
    "Linie >= 3 & Min <= 63 & 1:1": (o.line >= 3) & (o["min"] <= 63) & (o.h == o.a),
    "Linie >= 3 & Min <= 63 & 2:0": (o.line >= 3) & (o["min"] <= 63) & ((o.h - o.a).abs() == 2),
    "Min <= 60": o["min"] <= 60,
    "Linie >= 3.5": o.line >= 3.5,
}
for lab, msk in rules.items():
    print(row(lab, msk))
