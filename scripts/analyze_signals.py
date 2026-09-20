#!/usr/bin/env python3
"""Analyze an InPlayFlux signal export and report win-rate breakdowns
used to calibrate the strategy rules (signal-minute cutoffs, radar score,
market drop %).

Usage:
    python3 scripts/analyze_signals.py data/inplayflux_sinyaller_2026-09-20.csv
"""
import csv
import sys
from collections import defaultdict


def is_won(row):
    result = row["Sonuç (Result)"]
    if "✅" in result:
        return True
    if "❌" in result:
        return False
    return None


def to_float(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def win_rate(results):
    return sum(results) / len(results) if results else None


def bucket(value, edges, labels):
    if value is None:
        return None
    for edge, label in zip(edges, labels):
        if value < edge:
            return label
    return labels[-1]


def report_by_key(rows, key_fn, min_n=1):
    grouped = defaultdict(list)
    for row in rows:
        outcome = is_won(row)
        key = key_fn(row)
        if outcome is not None and key is not None:
            grouped[key].append(outcome)
    return {k: v for k, v in grouped.items() if len(v) >= min_n}


def main(path):
    with open(path, encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))

    decided = [is_won(r) for r in rows if is_won(r) is not None]
    print(f"Signals: {len(rows)}, decided: {len(decided)}")
    print(f"Overall win rate: {win_rate(decided):.1%}\n")

    print("--- Win rate by strategy (n>=20) ---")
    by_strategy = report_by_key(rows, lambda r: r["Strateji (Strategy)"], min_n=20)
    for strat, res in sorted(by_strategy.items(), key=lambda x: -len(x[1])):
        print(f"{strat[:45]:45s} n={len(res):4d} winrate={win_rate(res):.1%}")

    print("\n--- Win rate by signal minute, per strategy ---")
    for strat in sorted(by_strategy, key=lambda s: -len(by_strategy[s])):
        sub = [r for r in rows if r["Strateji (Strategy)"] == strat]
        by_min = report_by_key(
            sub, lambda r: int(to_float(r["Sinyal Dk (Signal Min)"]) or -1), min_n=15
        )
        print(f"\n  {strat}")
        for minute in sorted(by_min):
            res = by_min[minute]
            print(f"    min={minute:3d} n={len(res):4d} winrate={win_rate(res):.1%}")

    print("\n--- Win rate by Radar X Score bucket ---")
    edges = [200, 300, 350, 400, 450, float("inf")]
    labels = ["<200", "200-300", "300-350", "350-400", "400-450", ">=450"]
    by_radar = report_by_key(
        rows, lambda r: bucket(to_float(r["Radar X Score"]), edges, labels)
    )
    for label in labels:
        res = by_radar.get(label, [])
        if res:
            print(f"{label:10s} n={len(res):4d} winrate={win_rate(res):.1%}")

    print("\n--- Win rate by Market Drop % bucket ---")
    edges = [0, 0.001, 10, 20, 30, float("inf")]
    labels = ["<0", "0", "0-10", "10-20", "20-30", ">=30"]
    by_market = report_by_key(
        rows,
        lambda r: bucket(
            to_float(r["Market Düşüşü % (Market Drop %)"]), edges, labels
        ),
    )
    for label in labels:
        res = by_market.get(label, [])
        if res:
            print(f"{label:8s} n={len(res):4d} winrate={win_rate(res):.1%}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "data/inplayflux_sinyaller_2026-09-20.csv")
