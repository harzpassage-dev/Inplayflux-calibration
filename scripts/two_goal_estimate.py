"""Over 3.0 at 2 goals / Over 2.0 at 1 goal (Asian lines: one more goal = push, two more = win).

The exports only say whether the *next* goal fell and its minute (Sonuç Dk), not the final score. So the chance of a
second goal after that minute is estimated with a hazard model learnt from all cards (logistic: minute, pre-match line,
goals, minutes since the last goal) and tested in 10-fold group CV (folds by match). Output: win / push / loss shares and
the break-even Asian odds 1 + loss/win. Usage: python3 scripts/two_goal_estimate.py data/*.csv
"""
import os
import sys

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import GroupKFold

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from goal_drivers import features, load  # noqa: E402


def hz_feats(minute, line, goals, since):
    m = np.clip(minute, 0, 95)
    return np.c_[m, m ** 2 / 100, line, goals, np.clip(since, 0, 60)]


def main():
    df = load(sys.argv[1:])
    X = features(df)
    ok = X[["minute", "goalline_pre", "goals", "since_goal"]].notna().all(axis=1)
    df, X = df[ok].reset_index(drop=True), X[ok].reset_index(drop=True)
    y = df.won.to_numpy(int)
    groups = (df.Tarih.str[:10] + df["Maç"]).to_numpy()
    rmin = df["Sonuç Dk"].to_numpy(float)
    est = np.full(len(df), np.nan)   # P(second goal after the first one) for won cards
    calib = np.full(len(df), np.nan)  # out-of-fold prediction of the card's own next goal (calibration check)
    for tr, te in GroupKFold(10).split(X, y, groups):
        Xtr = hz_feats(X.minute[tr], X.goalline_pre[tr], X.goals[tr], X.since_goal[tr])
        lr = LogisticRegression(max_iter=1000).fit(Xtr, y[tr])
        calib[te] = lr.predict_proba(hz_feats(X.minute[te], X.goalline_pre[te], X.goals[te], X.since_goal[te]))[:, 1]
        w = te[(y[te] == 1) & ~np.isnan(rmin[te])]
        # after the first goal: minute = goal minute, one goal more, 0 minutes since the last goal
        est[w] = lr.predict_proba(hz_feats(rmin[w], X.goalline_pre[w], X.goals[w] + 1, np.zeros(len(w))))[:, 1]
    print("Kalibrierung (Vorhersage nächstes Tor, 10-fach, ungesehene Spiele):")
    for lo, hi in [(0, .6), (.6, .7), (.7, .8), (.8, 1)]:
        s = (calib >= lo) & (calib < hi)
        print(f"  vorhergesagt {lo:.1f}-{hi:.1f}: vorhergesagt {calib[s].mean()*100:5.1f}%  echt {y[s].mean()*100:5.1f}%  n={s.sum()}")
    late = rmin >= 90  # goal minute 90 means 90+: no time left for a second goal worth counting
    est = np.where(late & (y == 1), 0.03, est)

    def report(name, sel):
        n = sel.sum()
        won = y[sel]
        p2 = np.nan_to_num(est[sel], nan=0.0)
        win = (won * p2).mean()
        push = (won * (1 - p2)).mean()
        loss = 1 - won.mean()
        be = 1 + loss / win if win > 0 else float("inf")
        print(f"  {name:42s} n={n:5d}  Gewinn {win*100:5.1f}%  Push {push*100:5.1f}%  Verlust {loss*100:5.1f}%  Break-even-Quote {be:.2f}")

    g, line, mnt = X.goals, X.goalline_pre, X.minute
    print("\nOver 3.0 bei 2 Toren (O2.5-Karten):")
    report("alle", (g == 2).to_numpy())
    report("Linie >= 3.25", ((g == 2) & (line >= 3.25)).to_numpy())
    report("Linie >= 3.5 & Minute <= 60", ((g == 2) & (line >= 3.5) & (mnt <= 60)).to_numpy())
    report("Linie >= 4 & Minute <= 60", ((g == 2) & (line >= 4) & (mnt <= 60)).to_numpy())
    # spread over the 10 folds for the strongest O3.0 rule (each fold = unseen matches)
    sel = ((g == 2) & (line >= 3.5) & (mnt <= 60)).to_numpy()
    fold_be = []
    for k, (tr, te) in enumerate(GroupKFold(10).split(X, y, groups)):
        m = np.zeros(len(y), bool); m[te] = True; m &= sel
        win = (y[m] * np.nan_to_num(est[m])).mean(); loss = 1 - y[m].mean()
        fold_be.append(1 + loss / win)
    print(f"  -> Linie >= 3.5 & Minute <= 60, Break-even je Durchlauf: {' '.join(f'{b:.2f}' for b in fold_be)}")
    print("\nOver 2.0 bei 1 Tor (O1.5-Karten):")
    report("alle", (g == 1).to_numpy())
    report("Minute <= 61 & Linie >= 2.75 (Testregel)", ((g == 1) & (mnt <= 61) & (line >= 2.75)).to_numpy())
    report("Minute <= 61 & Linie >= 3.25", ((g == 1) & (mnt <= 61) & (line >= 3.25)).to_numpy())
    report("Minute <= 61 & Linie >= 3.5", ((g == 1) & (mnt <= 61) & (line >= 3.5)).to_numpy())


if __name__ == "__main__":
    main()
