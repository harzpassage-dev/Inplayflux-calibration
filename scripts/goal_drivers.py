#!/usr/bin/env python3
"""Why and when does the next goal fall after a signal?

Every strategy in the exports needs exactly one more goal (O2.5 at 2 goals,
O3.5 at 3, "Goal" at 0-0, ...), so all signals share one outcome: does
another goal fall before full time. This script

  1. reconstructs the Radar X Score from the live stats at signal time,
  2. reports when the goal falls (wait time, stoppage time, hazard per
     remaining minute),
  3. measures each condition's lift over a minute+line baseline, checked
     separately on an older and a newer time window,
  4. fits the points-based goal score used by scripts/live_radar.py on the
     older window, reports it on the newer window, then refits on all data
     and writes calibration/goal_score.json.

Needs pandas and scikit-learn (pip install pandas scikit-learn).

Usage:
    python3 scripts/goal_drivers.py data/*.csv
"""
import glob
import json
import os
import sys

import numpy as np
import pandas as pd
from sklearn.linear_model import LinearRegression, LogisticRegression
from sklearn.metrics import roc_auc_score

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_PATH = os.path.join(ROOT, "calibration", "goal_score.json")
SPLIT_DATE = "2026-09-27"  # train on signals before this date, validate on the rest
POINT_SCALE = 0.1  # one point = 0.1 log-odds

SCORE_BANDS = [(-99, -9, "<=-9"), (-8, -6, "-8..-6"), (-5, -3, "-5..-3"), (-2, 0, "-2..0"), (1, 99, ">=+1")]


def load(paths):
    df = pd.concat([pd.read_csv(p, encoding="utf-8-sig") for p in paths], ignore_index=True)
    df.columns = [c.split(" (")[0] for c in df.columns]
    df["Tarih"] = df["Tarih"].astype(str).str.strip('="')
    df["Skor"] = df["Skor"].astype(str).str.strip('="')
    df = df.drop_duplicates(subset=["Tarih", "Maç", "Strateji", "Sinyal Dk"]).reset_index(drop=True)
    df["won"] = df["Sonuç"].map(lambda s: 1 if "✅" in str(s) else (0 if "❌" in str(s) else np.nan))
    return df[df.won.notna()].copy()


def features(df):
    f = lambda c: df[c].fillna(0)
    over, under = df["O/U Üst Oranı"], df["O/U Alt Oranı"]
    X = pd.DataFrame(index=df.index)
    X["minute"] = df["Sinyal Dk"]
    X["goals"] = df["Toplam Gol Sinyal Anı"]
    X["radar"] = df["Radar X Score"]
    X["over_fav"] = ((over < under) & (over > 0)).astype(int)
    X["over_odds"] = over.where(over > 0)
    X["da"] = f("Tehlikeli Atak Ev") + f("Tehlikeli Atak Dep")
    X["atk"] = f("Atak Ev") + f("Atak Dep")
    X["corners"] = f("Korner Ev") + f("Korner Dep")
    X["shots"] = f("Şut Toplam Ev") + f("Şut Toplam Dep")
    X["sot"] = f("Şut İsabetli Ev") + f("Şut İsabetli Dep")
    X["avg_goals"] = f("Ort Gol Atar Ev") + f("Ort Gol Atar Dep")
    X["avg_conc"] = f("Ort Gol Yer Ev") + f("Ort Gol Yer Dep")
    X["since_goal"] = df["Son Golden Geçen Süre"]
    X["goalline_pre"] = df["MÖ Gol Baremi"]
    X["ht_line_pre"] = df["MÖ İY Gol Baremi"]
    X["room"] = X.goalline_pre - X.goals
    home, away = df["Skor"].str.split("-", expand=True).astype(float).T.values
    fav_home = df["KO Oran Ev"] < df["KO Oran Dep"]
    X["fav_margin"] = np.where(fav_home, home - away, away - home)
    return X


def score_conditions(X):
    """Binary conditions behind the goal score. Keep in sync with
    goal_score_conditions() in scripts/live_radar.py."""
    return pd.DataFrame({
        "min_58_62": X.minute.between(58, 62),
        "min_63_65": X.minute.between(63, 65),
        "min_66p": X.minute >= 66,
        "line_lo": X.goalline_pre <= 2.5,
        "line_hi": X.goalline_pre >= 3.25,
        "ht_hi": X.ht_line_pre >= 1.5,
        "def_strong": X.avg_conc <= 2.2,
        "sot9": X.sot >= 9,
        "recent_goal": X.since_goal <= 5,
        "over_odds_hi": X.over_odds > 2.03,
        "fav_up1": X.fav_margin == 1,
    }).astype(int)


def radar_reconstruction(X):
    cols = ["over_fav", "da", "atk", "corners", "shots", "sot", "avg_goals", "avg_conc", "minute", "goals"]
    lr = LinearRegression().fit(X[cols], X.radar)
    print("\n=== 1. Radar X rekonstruiert (lineare Regression) ===")
    print(f"R² = {lr.score(X[cols], X.radar):.3f}, Intercept {lr.intercept_:.1f}")
    for c, v in zip(cols, lr.coef_):
        print(f"  {c:12} {v:+8.2f}")
    print(X.groupby("over_fav").radar.agg(["mean", "count"]).round(1))


def goal_timing(df):
    won = df[df.won == 1]
    wait = won["Bekleme dk"]
    print("\n=== 2. Wann fällt das Tor? ===")
    print(f"Torquote gesamt {df.won.mean() * 100:.1f}% (n={len(df)})")
    print(f"Wartezeit Median {wait.median():.0f} min, Quartile {wait.quantile(.25):.0f}-{wait.quantile(.75):.0f} min")
    for m in (5, 10, 15, 20, 30):
        print(f"  Tor innerhalb {m:2} min: {(wait <= m).sum() / len(df) * 100:4.1f}% aller Signale")
    print(f"  Tor in der Nachspielzeit (>90'): {(won['Sonuç Dk'] > 90).mean() * 100:.1f}% der Treffer")
    rem = (93 - df["Sinyal Dk"]).clip(lower=5)
    g = df.assign(rem=rem).groupby(pd.cut(df["Sinyal Dk"], [0, 57, 60, 63, 66, 69, 72, 90]), observed=True)
    print(pd.DataFrame({"n": g.size(), "torquote": g.won.mean().round(3),
                        "tor_pro_restminute_%": (g.won.mean() / g.rem.mean() * 100).round(2)}))


def condition_lifts(df, X, train):
    y = df.won
    conds = {
        "Vorab-Linie >= 3.25": X.goalline_pre >= 3.25, "Vorab-Linie <= 2.5": X.goalline_pre <= 2.5,
        "HT-Linie >= 1.5": X.ht_line_pre >= 1.5, "HT-Linie <= 1.0": X.ht_line_pre <= 1.0,
        "Minute <= 57": X.minute <= 57, "Minute >= 66": X.minute >= 66,
        "SoT >= 9": X.sot >= 9, "SoT <= 4": X.sot <= 4,
        "Gegentor-Schnitt <= 2.2": X.avg_conc <= 2.2, "Gegentor-Schnitt >= 3": X.avg_conc >= 3,
        "Score >= Vorab-Linie": X.room <= 0, "Score < Vorab-Linie - 1": X.room > 1,
        "Over-Quote > 2.03": X.over_odds > 2.03, "Over favorisiert": X.over_fav == 1,
        "Radar >= 400": X.radar >= 400, "Radar < 260": X.radar < 260,
        "Letztes Tor <= 5 min her": X.since_goal <= 5, "Favorit führt mit 1 Tor": X.fav_margin == 1,
    }
    print("\n=== 3. Bedingungen: Torquote-Abweichung (pp) alt vs. neu ===")
    print(f"{'Bedingung':28} {'n alt':>6} {'Δ alt':>6} {'n neu':>6} {'Δ neu':>6}")
    rows = []
    for name, mask in conds.items():
        a, b = mask & train, mask & ~train
        rows.append((name, a.sum(), (y[a].mean() - y[train].mean()) * 100,
                     b.sum(), (y[b].mean() - y[~train].mean()) * 100))
    for r in sorted(rows, key=lambda r: -(r[2] + r[4])):
        print(f"{r[0]:28} {r[1]:6} {r[2]:+6.1f} {r[3]:6} {r[4]:+6.1f}")


def band_table(score, y):
    out = {}
    for lo, hi, label in SCORE_BANDS:
        m = score.between(lo, hi)
        if m.sum():
            out[label] = {"min": lo, "max": hi, "n": int(m.sum()), "wr": round(float(y[m].mean()), 3),
                          "breakeven_odds": round(1 / float(y[m].mean()), 2)}
    return out


def fit_goal_score(df, X, train):
    y = df.won.astype(int)
    B = score_conditions(X)
    lr = LogisticRegression(C=0.5, max_iter=2000).fit(B[train], y[train])
    pts = (pd.Series(lr.coef_[0], B.columns) / POINT_SCALE).round().astype(int)
    score = (B * pts).sum(axis=1)
    val_auc = roc_auc_score(y[~train], score[~train])
    print("\n=== 4. Tor-Score ===")
    print(f"AUC auf neuem Zeitraum (gelernt nur auf altem): {val_auc:.3f}")
    for name, part in (("alt", train), ("neu", ~train)):
        print(name, {k: (v["n"], v["wr"]) for k, v in band_table(score[part], y[part]).items()})

    final = LogisticRegression(C=0.5, max_iter=2000).fit(B, y)
    pts = (pd.Series(final.coef_[0], B.columns) / POINT_SCALE).round().astype(int)
    score = (B * pts).sum(axis=1)
    bands = band_table(score, y)
    print("final (alle Daten):", pts.to_dict())
    for k, v in bands.items():
        print(f"  {k:7} n={v['n']:5} Torquote {v['wr'] * 100:4.1f}%  Mindestquote {v['breakeven_odds']}")
    return {
        "note": "Points-based goal score: chance that one more goal falls after the signal. "
                "Generated by scripts/goal_drivers.py; read by scripts/live_radar.py.",
        "n_signals": int(len(df)),
        "validation": f"points fit on signals before {SPLIT_DATE}, scored on the rest",
        "validation_auc_newer_window": round(float(val_auc), 3),
        "points": {k: int(v) for k, v in pts.items()},
        "bands": bands,
    }


def main():
    paths = sys.argv[1:] or sorted(glob.glob(os.path.join(ROOT, "data", "inplayflux_sinyaller_*.csv")))
    df = load(paths)
    X = features(df)
    train = pd.to_datetime(df["Tarih"].str[:10]) < pd.Timestamp(SPLIT_DATE)
    radar_reconstruction(X)
    goal_timing(df)
    condition_lifts(df, X, train)
    result = fit_goal_score(df, X, train)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"\n-> {os.path.relpath(OUT_PATH, ROOT)} geschrieben")


if __name__ == "__main__":
    main()
