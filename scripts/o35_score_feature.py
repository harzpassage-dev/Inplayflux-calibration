#!/usr/bin/env python3
"""Hilft der Spielstand (3:0/0:3 vs 2:1/1:2) dem Over-3.5-Modell? Vergleicht das heutige Modell
[minute, sot, radar, goalline_pre] mit demselben Modell + Merkmal "klar" (Tordifferenz 3):
5-fach CV und Zeit-Test (gelernt bis --split, getestet danach), jeweils bei gleicher Tippzahl.

  python3 scripts/o35_score_feature.py data/*.csv --split "2026-10-17 20:16:00"
"""
import argparse, os, sys
import numpy as np
from sklearn.model_selection import StratifiedKFold
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from goal_drivers import features, load  # noqa: E402
from recalibrate import fit, predict  # noqa: E402

ap = argparse.ArgumentParser(); ap.add_argument("files", nargs="+"); ap.add_argument("--split", default="2026-10-17 20:16:00")
a = ap.parse_args()
df = load(a.files); X = features(df)
sc = df["Skor"].astype(str).str.extract(r"(\d+)\s*-\s*(\d+)").astype(float)
X["clear"] = ((sc[0] - sc[1]).abs() == 3).astype(float)
mask = (X.goals == 3) & X[["minute", "sot", "radar", "goalline_pre"]].notna().all(axis=1)
y = df.loc[mask, "won"].to_numpy(int); dates = df.loc[mask, "Tarih"].to_numpy()
base = ["minute", "sot", "radar", "goalline_pre"]
for name, cols in [("heute (4 Merkmale)", base), ("+ Spielstand klar", base + ["clear"])]:
    Xm = X.loc[mask, cols].to_numpy(float)
    oof = np.zeros(len(y))
    for tr, te in StratifiedKFold(5, shuffle=True, random_state=1).split(Xm, y):
        oof[te] = predict(fit(Xm[tr], y[tr]), Xm[te])
    print(f"\n== {name}: n={len(y)}, Grundquote {y.mean()*100:.1f}%")
    for t in (0.72, 0.75, 0.78, 0.80):
        s = oof >= t; print(f"  CV p>={t:.2f}: {y[s].mean()*100:5.1f}% n={s.sum()}")
    for top in (1000, 600):
        idx = np.argsort(-oof)[:top]; print(f"  CV beste {top}: {y[idx].mean()*100:5.1f}%")
    tr, te = dates <= a.split, dates > a.split
    m = fit(Xm[tr], y[tr]); p = predict(m, Xm[te])
    for t in (0.72, 0.75, 0.78):
        s = p >= t; print(f"  Zeit-Test p>={t:.2f}: {y[te][s].mean()*100:5.1f}% n={s.sum()}  (alle neu {y[te].mean()*100:.1f}% n={te.sum()})")
    for top in (80, 120):
        idx = np.argsort(-p)[:top]; print(f"  Zeit-Test beste {top}: {y[te][idx].mean()*100:5.1f}%")
    full = fit(Xm, y); print("  Gewichte:", dict(zip(cols, np.round(full["coef"], 3))))
