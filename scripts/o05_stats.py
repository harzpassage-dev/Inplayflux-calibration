#!/usr/bin/env python3
"""Over 0.5 (Karten bei 0:0, Ziel "Goal"/"Over 0.5"): Trefferquote nach Strategie, Minute, Vor-Spiel-Linie,
Schüssen aufs Tor, Radar, Hälften und neuen Tagen; wann das erste Tor fällt.

  python3 scripts/o05_stats.py data/*.csv
"""
import glob, sys
import pandas as pd

files = sys.argv[1:] or sorted(glob.glob("data/*.csv"))
d = pd.concat([pd.read_csv(f, dtype=str) for f in files], ignore_index=True)
c = lambda k: [x for x in d.columns if x.startswith(k)][0]
d = d.drop_duplicates([c("Tarih"), c("Maç"), c("Strateji"), c("Sinyal Dk")]).reset_index(drop=True)
d = d[d[c("Sonuç (")].astype(str).str.contains("won|lost", case=False)].reset_index(drop=True)
num = lambda k: pd.to_numeric(d[c(k)].astype(str).str.replace("=", "").str.replace('"', ""), errors="coerce")
sc = d[c("Skor")].astype(str).str.extract(r"(\d+)\s*-\s*(\d+)").astype(float)
d["g"] = sc[0] + sc[1]
d["win"] = d[c("Sonuç (")].str.contains("won", case=False)
d["t"] = d[c("Tarih")].str.extract(r"(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)")[0]
d["min"], d["rmin"] = num("Sinyal Dk"), num("Sonuç Dk")
d["line"], d["radar"] = num("MÖ Gol Baremi"), num("Radar X")
d["sot"] = num("Şut İsabetli Ev") + num("Şut İsabetli Dep")
d["shots"] = num("Şut Toplam Ev") + num("Şut Toplam Dep")
d["strat"] = d[c("Strateji")].str.strip()
tg = d[c("Hedef")].astype(str)
o = d[(d.g == 0) & tg.isin(["Goal", "Over 0.5"])].copy()
mid = "2026-10-01"
A, B = o.t < mid, o.t >= mid
NEW = "2026-10-17 20:16:00"

def row(lab, m):
    n = int(m.sum())
    if not n:
        return f"  {lab:30s} n=0"
    a, b, nw = o.loc[m & A, "win"], o.loc[m & B, "win"], o.loc[m & (o.t > NEW), "win"]
    f = lambda s: f"{s.mean()*100:5.1f}% (n{len(s)})" if len(s) else "   –      "
    return f"  {lab:30s} n={n:5d} {o.loc[m,'win'].mean()*100:5.1f}%  | vor 1.10. {f(a)} | ab 1.10. {f(b)} | neu ab 17.10. {f(nw)}"

print(f"Over 0.5: {len(o)} Karten, {o.t.min()[:10]}–{o.t.max()[:10]}, {(o.t.str[:10] + o[c('Maç')]).nunique()} verschiedene Spiele")
print(row("ALLE", o.win.notna()))
print("\n-- Strategie")
for s, n in o.strat.value_counts().items():
    if n >= 15:
        print(row(s[:30], o.strat == s))
print("\n-- Minute")
for lo, hi in [(0, 59), (60, 60), (61, 61), (62, 63), (64, 70), (71, 99)]:
    print(row(f"{lo}-{hi}", o["min"].between(lo, hi)))
print("\n-- Vor-Spiel-Linie")
for lab, m in [("<= 2.5", o.line <= 2.5), ("2.75-3.0", o.line.between(2.75, 3.0)), ("3.25-3.5", o.line.between(3.25, 3.5)), (">= 3.75", o.line >= 3.75)]:
    print(row(lab, m))
print("\n-- Schüsse aufs Tor")
for lab, m in [("0-2", o.sot <= 2), ("3-4", o.sot.between(3, 4)), ("5-6", o.sot.between(5, 6)), ("7+", o.sot >= 7)]:
    print(row(lab, m))
print("\n-- Radar X")
for lab, m in [("< 250", o.radar < 250), ("250-349", o.radar.between(250, 349)), ("350-449", o.radar.between(350, 449)), (">= 450", o.radar >= 450)]:
    print(row(lab, m))
print("\n-- Kombinationen")
print(row("Linie >= 3.25", o.line >= 3.25))
print(row("Linie >= 3.25 & Radar >= 350", (o.line >= 3.25) & (o.radar >= 350)))
print(row("Linie >= 3 & Min <= 61", (o.line >= 3) & (o["min"] <= 61)))
w = o[o.win]
print("\n-- Wann fällt das 1. Tor (gewonnene Karten)")
for lo, hi in [(0, 70), (71, 80), (81, 90), (91, 130)]:
    print(f"  {lo}-{hi}: {(w.rmin.between(lo, hi)).mean()*100:4.1f}%")
print(f"  Median Wartezeit {(w.rmin - w['min']).median()} min")
