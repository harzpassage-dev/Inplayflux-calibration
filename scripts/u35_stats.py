#!/usr/bin/env python3
"""Under 3.5 neu berechnen aus dem Admin-Protokoll "Under 3.5 (still protokolliert)" (CSV-Knopf).

Streng gezählt ("strict"): nur Zeilen mit Tor-Score, und "won" nur, wenn das Spiel spät noch im Feed
gesehen wurde (seen_late) – sonst ist "kein 4. Tor" nicht sicher. Lost zählt immer. Zeigt Trefferquote
nach Tor-Score, Live-Linie, Premium ja/nein, Markt und Minute, getrennt nach zwei Zeiträumen, plus
Gewinn bei Live-Linie genau 3,5 (nur dort ist die Under-Quote die echte Under-3.5-Quote).

  python3 scripts/u35_stats.py under35_log_<datum>.csv
"""
import sys
import pandas as pd

d = pd.read_csv(sys.argv[1])
d = d[d.goal_score.notna() & d.status.isin(["won", "lost"])]
d = d[(d.status == "lost") | d.seen_late.notna()].copy()  # seen_late = minute the match was last seen at 85'+
d["win"] = d.status == "won"
d["t"] = pd.to_datetime(d.time)
mid = d.t.min() + (d.t.max() - d.t.min()) / 2
A = d.t <= mid
print(f"Streng gezählte Spiele: {len(d)} ({d.t.min():%d.%m.}–{d.t.max():%d.%m.}), Hälften getrennt bei {mid:%d.%m. %H:%M}")

def row(lab, m):
    x, a, b = d[m], d[m & A], d[m & ~A]
    if not len(x):
        return f"  {lab:34s} n=0"
    f = lambda s: f"{s.win.mean()*100:5.1f}% (n{len(s)})" if len(s) else "   –     "
    p35 = x[(x.line == 3.5) & x.under.notna()]
    prof = (p35.win * (p35.under - 1) - (~p35.win)).sum() if len(p35) else 0
    return (f"  {lab:34s} n={len(x):4d} {x.win.mean()*100:5.1f}% | 1. Hälfte {f(a)} | 2. Hälfte {f(b)}"
            f" | Linie 3,5: {len(p35)} Spiele, {prof:+.1f} E. (Ø Quote {p35.under.mean():.2f})" if len(p35) else
            f"  {lab:34s} n={len(x):4d} {x.win.mean()*100:5.1f}% | 1. Hälfte {f(a)} | 2. Hälfte {f(b)}")

print(row("ALLE", d.win.notna()))
print("\n-- Tor-Score")
for lab, m in [("<= -3", d.goal_score <= -3), ("-2..0", d.goal_score.between(-2, 0)), ("+1..+2", d.goal_score.between(1, 2)), (">= +3", d.goal_score >= 3)]:
    print(row(lab, m))
print("\n-- Live-Linie")
for lab, m in [("<= 3.0", d.line <= 3.0), ("3.25-3.5", d.line.between(3.25, 3.5)), (">= 3.75", d.line >= 3.75)]:
    print(row(lab, m))
print("\n-- Premium-Karte (Over 2.5 gepostet)")
print(row("nein", d.premium.astype(str).str.lower() != "true"))
print(row("ja", d.premium.astype(str).str.lower() == "true"))
print("\n-- Markt (Wahrscheinlichkeit Under 3.5)")
for lab, m in [("< 50 %", d.market_u35 < 0.5), ("50-60 %", d.market_u35.between(0.5, 0.6)), (">= 60 %", d.market_u35 > 0.6)]:
    print(row(lab, m))
print("\n-- Minute")
for lab, m in [("<= 57", d.minute <= 57), ("58-62", d.minute.between(58, 62)), (">= 63", d.minute >= 63)]:
    print(row(lab, m))
print("\n-- Regeln")
np_ = d.premium.astype(str).str.lower() != "true"
for lab, m in [
    ("alte Regel: Score <= 0 & Linie <= 3.5", (d.goal_score <= 0) & (d.line <= 3.5)),
    ("  dito, nur Nicht-Premium", (d.goal_score <= 0) & (d.line <= 3.5) & np_),
    ("Score <= -2 & Linie <= 3.5", (d.goal_score <= -2) & (d.line <= 3.5)),
    ("Score <= 0 & Markt >= 55 %", (d.goal_score <= 0) & (d.market_u35 >= 0.55)),
    ("Linie <= 3.0", d.line <= 3.0),
]:
    print(row(lab, m))
print("\nMindestquote bei Trefferquote p: 1/p (z. B. 70 % -> 1,43; 65 % -> 1,54).")
