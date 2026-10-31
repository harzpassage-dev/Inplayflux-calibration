"""Walk-forward threshold check: refit the confidence model weekly and test each threshold on the next week
(unseen days). Usage: python3 scripts/threshold_walkforward.py  (edit `cuts` to the export dates)."""
import sys, glob, numpy as np
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from goal_drivers import features, load
from recalibrate import fit, predict, FEATS
df = load(sorted(glob.glob("data/*.csv"))); X = features(df); X["line"] = X.goals + 0.5
cuts = ["2026-10-10 18:00", "2026-10-17 18:00", "2026-10-24 18:00", "2026-10-31 23:59"]
TH = [0.75, 0.78, 0.80, 0.82, 0.84, 0.86, 0.88]
for line, cur in [(2.5, .80), (3.5, .75), (0.5, .75)]:
    mask = (X.line == line) & X[FEATS].notna().all(axis=1)
    Xm, y = X.loc[mask, FEATS].to_numpy(float), df.loc[mask, "won"].to_numpy(int)
    d = df.loc[mask, "Tarih"].to_numpy()
    P, Y, W = [], [], []
    for i in range(len(cuts) - 1):
        tr = d <= cuts[i]; te = (d > cuts[i]) & (d <= cuts[i+1])
        if te.sum() == 0: continue
        P.append(predict(fit(Xm[tr], y[tr]), Xm[te])); Y.append(y[te]); W.append(np.full(te.sum(), i))
    P, Y, W = np.concatenate(P), np.concatenate(Y), np.concatenate(W)
    days = 21
    print(f"\nO{line} (aktuell {cur}), ungesehen 10.–31.10., alle Karten {Y.mean()*100:.1f}% n={len(Y)}")
    for t in TH:
        s = P >= t
        if s.sum() < 5: print(f"  >= {t:.2f}: n<5"); continue
        per = [f"{Y[s & (W==k)].mean()*100:4.0f}%({(s&(W==k)).sum()})" for k in range(3)]
        print(f"  >= {t:.2f}: {Y[s].mean()*100:5.1f}%  n={s.sum():4d}  ~{s.sum()/days:4.1f}/Tag  Break-even {1/Y[s].mean():.2f}   Wochen: {' '.join(per)}{'  <- jetzt' if abs(t-cur)<1e-9 else ''}")
