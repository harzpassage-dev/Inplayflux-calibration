#!/usr/bin/env python3
"""Recalibrate from all signal exports: the worker's live confidence models
(premium filter) and the analyst tool's bucket tables.

- live_confidence_models: one logistic regression per target line on
  [minute, total_sot, radar, goalline_pre], z-scored. Reports 5-fold
  out-of-fold win rates per threshold and a time split (train before
  --split, test after), so a threshold can be checked on unseen days.
- tool_calibration: o25Buckets / o35Matrix / o15Buckets / o05Buckets,
  same bins as before, win rates recomputed.

Writes calibration/rules.json (models, buckets, source list) and prints the
JS blocks for worker/src/index.js (CONFIDENCE_MODELS) and the tool's
DEFAULT_CALIB. Thresholds are kept from rules.json unless --threshold
LINE=VALUE is given.

Needs pandas and scikit-learn.

Usage:
    python3 scripts/recalibrate.py data/*.csv --split "2026-10-06 18:00:00"
    python3 scripts/recalibrate.py data/*.csv --write --threshold 2.5=0.82
"""
import argparse
import json
import os
import sys

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import StratifiedKFold

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from goal_drivers import features, load  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RULES = os.path.join(ROOT, "calibration", "rules.json")
FEATS = ["minute", "sot", "radar", "goalline_pre"]
LINES = [2.5, 3.5, 1.5, 0.5]
THRESHOLDS = [0.70, 0.72, 0.75, 0.78, 0.80, 0.82, 0.85]


def fit(Xm, y):
    mean, std = Xm.mean(axis=0), Xm.std(axis=0)
    std[std == 0] = 1
    lr = LogisticRegression().fit((Xm - mean) / std, y)
    return {"mean": mean, "std": std, "coef": lr.coef_[0], "intercept": lr.intercept_[0]}


def predict(m, Xm):
    z = ((Xm - m["mean"]) / m["std"]) @ m["coef"] + m["intercept"]
    return 1 / (1 + np.exp(-z))


def rate(p, y, t):
    sel = p >= t
    return (y[sel].mean() if sel.any() else float("nan")), int(sel.sum()), sel.mean()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--split", default=None)
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--threshold", action="append", default=[])
    a = ap.parse_args()

    df = load(a.files)
    X = features(df)
    X["line"] = X.goals + 0.5
    rules = json.load(open(RULES, encoding="utf-8"))
    old = rules["live_confidence_models"]
    thr = {float(k): v["threshold"] for k, v in old.items() if k != "note"}
    for t in a.threshold:
        k, v = t.split("=")
        thr[float(k)] = float(v)

    print(f"{len(df)} entschiedene Signale, {df.Tarih.min()[:10]} bis {df.Tarih.max()[:10]}")
    models, notes = {}, []
    for line in LINES:
        mask = (X.line == line) & X[FEATS].notna().all(axis=1)
        Xm, y = X.loc[mask, FEATS].to_numpy(float), df.loc[mask, "won"].to_numpy(int)
        oof = np.zeros(len(y))
        for tr, te in StratifiedKFold(5, shuffle=True, random_state=1).split(Xm, y):
            oof[te] = predict(fit(Xm[tr], y[tr]), Xm[te])
        print(f"\n=== O{line}: n={len(y)}, Grundquote {y.mean() * 100:.1f}%  (5-fach CV, out-of-fold)")
        for t in THRESHOLDS:
            wr, n, share = rate(oof, y, t)
            mark = "  <- Schwelle" if abs(t - thr[line]) < 1e-9 else ""
            print(f"  p>={t:.2f}: {wr * 100:5.1f}%  n={n:5}  ({share * 100:4.1f}% Volumen){mark}")
        if a.split:
            dates = df.loc[mask, "Tarih"].to_numpy()
            tr, te = dates <= a.split, dates > a.split
            if te.sum() and tr.sum():
                p = predict(fit(Xm[tr], y[tr]), Xm[te])
                wr, n, _ = rate(p, y[te], thr[line])
                print(f"  Zeit-Test (gelernt bis {a.split[:10]}, getestet danach): p>={thr[line]:.2f} -> {wr * 100:5.1f}% n={n}  (alle danach: {y[te].mean() * 100:.1f}% n={te.sum()})")
        m = fit(Xm, y)
        wr, n, share = rate(oof, y, thr[line])
        models[line] = {
            "mean": [round(float(v), 4) for v in m["mean"]],
            "std": [round(float(v), 4) for v in m["std"]],
            "coef": [round(float(v), 4) for v in m["coef"]],
            "intercept": round(float(m["intercept"]), 4),
            "threshold": thr[line],
        }
        notes.append(f"O{line} >={thr[line]:.2f} -> {wr * 100:.1f}% (n={n}, {share * 100:.1f}% of volume)")

    def buckets(line, bins, extra=None):
        out = []
        for b in bins:
            lo, hi = (b["minMin"], b["maxMin"]) if "minMin" in b else (b["min"], b["max"])
            sel = (X.line == line) & X.minute.between(lo, hi)
            if extra:
                sel &= extra(b)
            n = int(sel.sum())
            out.append({**{k: v for k, v in b.items() if k not in ("wr", "n")},
                        "wr": round(df.loc[sel, "won"].mean() * 100, 1) if n else b["wr"], "n": n})
        return out

    tc = rules["tool_calibration"]
    tc["o25Buckets"] = buckets(2.5, tc["o25Buckets"])
    tc["o35Matrix"] = buckets(3.5, tc["o35Matrix"], lambda b: (X.sot >= 9) if b["sot"] == "9+" else (X.sot <= 8))
    tc["o15Buckets"] = buckets(1.5, tc["o15Buckets"])
    tc["o05Buckets"] = buckets(0.5, tc["o05Buckets"])
    print("\n=== Tool-Buckets")
    for k in ("o25Buckets", "o35Matrix", "o15Buckets", "o05Buckets"):
        print(k, ", ".join(f"{b['label']}{'/' + b['sot'] if 'sot' in b else ''} {b['wr']}% (n={b['n']})" for b in tc[k]))

    js = ["const CONFIDENCE_MODELS = {"]
    for line, m in models.items():
        js.append(f"  {line}: {{\n    mean: {m['mean']},\n    std: {m['std']},\n    coef: {m['coef']},\n"
                  f"    intercept: {m['intercept']},\n    threshold: {m['threshold']:.2f},\n  }},")
    js.append("};")
    print("\n" + "\n".join(js))

    if a.write:
        files = sorted(os.path.relpath(os.path.abspath(f), ROOT) for f in a.files)
        rules["source_files"] = files
        rules["generated_from_signals"] = len(df)
        rules["live_confidence_models"] = {
            "note": ("Logistic-regression models powering worker/src/index.js's CONFIDENCE_MODELS. Features "
                     "[minute, total_sot, radar, goalline_pre], z-scored with mean/std, then coef+intercept, "
                     "sigmoid. Generated by scripts/recalibrate.py. 5-fold out-of-fold win rates at the live "
                     "thresholds: " + "; ".join(notes) + "."),
            **{str(k): v for k, v in models.items()},
        }
        with open(RULES, "w", encoding="utf-8") as f:
            json.dump(rules, f, ensure_ascii=False, indent=2)
            f.write("\n")
        print(f"\n{RULES} geschrieben.")


if __name__ == "__main__":
    main()
