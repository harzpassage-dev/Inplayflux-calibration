#!/usr/bin/env python3
"""Evaluate the premium channel: join the worker's premium log (admin panel
-> "Log als CSV exportieren") with InPlayFlux signal exports that carry the
final result, and report hit rates per tier.

Tiers in the log:
    forwarded  posted as "High Confidence" (before 2026-10-05 instantly, since
               then only after the 2-minute live check)
    risk       posted as "Risiko" (minute >= 70)
    confirmed  passed the 2-minute live check (also appears as forwarded)
    rejected   held back by the live check - shows what the check filtered out

Quotes: since 2026-10-06 the log carries the live over/under quote at signal
time and at posting (signal_* / post_* columns). ROI is only computed where
the logged line equals the target line.

Matching: same target line, same teams (normalised), log date within one day
of the export date, signal minute within 3 minutes when both are known.

Usage:
    python3 scripts/premium_report.py premium_log_2026-10-06.csv data/inplayflux_sinyaller_2026-10-06.csv
    python3 scripts/premium_report.py premium_log.csv data/*.csv
"""
import csv
import re
import sys
import unicodedata
from collections import defaultdict
from datetime import date, timedelta


def norm(name):
    name = unicodedata.normalize("NFKD", str(name or "")).lower()
    return re.sub(r"[^a-z0-9]+", "", name)


def to_float(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def parse_day(v):
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})", str(v or ""))
    return date(int(m.group(1)), int(m.group(2)), int(m.group(3))) if m else None


def load_exports(paths):
    """(home, away, line) -> list of (day, minute, won) from the signal exports."""
    index = defaultdict(list)
    for path in paths:
        with open(path, encoding="utf-8-sig", newline="") as f:
            for row in csv.DictReader(f):
                row = {k.split(" (")[0]: v for k, v in row.items()}
                res = row.get("Sonuç", "")
                won = True if "✅" in res else False if "❌" in res else None
                if won is None:
                    continue
                teams = row.get("Maç", "").split(" vs ")
                if len(teams) != 2:
                    continue
                target = row.get("Hedef", "")
                m = re.search(r"([\d.]+)", target)
                goals = to_float(row.get("Toplam Gol Sinyal Anı"))
                line = to_float(m.group(1)) if m else (goals + 0.5 if goals is not None else None)
                if line is None:
                    continue
                index[(norm(teams[0]), norm(teams[1]), line)].append(
                    (parse_day(row.get("Tarih")), to_float(row.get("Sinyal Dk")), won))
    return index


def match(index, rec):
    cands = index.get((norm(rec["home"]), norm(rec["away"]), to_float(rec["target_line"])), [])
    day = parse_day(rec["date"] or rec["time"])
    minute = to_float(rec["signal_minute"])
    best = None
    for c_day, c_min, won in cands:
        if day and c_day and abs((c_day - day).days) > 1:
            continue
        if minute is not None and c_min is not None and abs(c_min - minute) > 3:
            continue
        dist = abs(c_min - minute) if minute is not None and c_min is not None else 99
        if best is None or dist < best[0]:
            best = (dist, won)
    return None if best is None else best[1]


def summary(label, rows):
    decided = [r for r in rows if r["won"] is not None]
    n, w = len(decided), sum(r["won"] for r in decided)
    unmatched = len(rows) - n
    if not n:
        print(f"{label:34} n=0 (ohne Ergebnis: {unmatched})")
        return
    wr = w / n
    probas = [to_float(r["signal_proba"]) for r in decided if to_float(r["signal_proba"])]
    pred = f"  Ø Modell {sum(probas) / len(probas) * 100:4.1f}%" if probas else ""
    print(f"{label:34} {w:4}/{n:<4} = {wr * 100:5.1f}%  Mindestquote {1 / wr:4.2f}{pred}"
          f"  (ohne Ergebnis: {unmatched})")
    # Real return, only where the logged live quote is for the signal's own
    # target line (InPlayFlux logs the market's main line, which can differ).
    priced = [r for r in decided if to_float(r.get("post_over")) and
              to_float(r.get("post_line")) == to_float(r.get("target_line"))]
    if priced:
        odds = [to_float(r["post_over"]) for r in priced]
        profit = sum((o - 1) if r["won"] else -1 for o, r in zip(odds, priced))
        above = sum(o >= 1 / wr for o in odds)
        print(f"{'':34} mit Quote auf Ziel-Linie: n={len(priced)}, Ø Quote {sum(odds) / len(odds):4.2f}, "
              f"über Mindestquote {above}/{len(priced)}, ROI {profit / len(priced) * 100:+5.1f}%")


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    with open(sys.argv[1], encoding="utf-8-sig", newline="") as f:
        log = list(csv.DictReader(f))
    index = load_exports(sys.argv[2:])
    for rec in log:
        rec["won"] = match(index, rec)

    by_kind = defaultdict(list)
    for rec in log:
        by_kind[rec["kind"]].append(rec)
    days = sorted({parse_day(r["date"] or r["time"]) for r in log if parse_day(r["date"] or r["time"])})
    print(f"Premium-Log: {len(log)} Einträge, {days[0]} bis {days[-1]}" if days else "Premium-Log leer")

    print("\n=== Gepostet ===")
    summary("High Confidence (alle)", by_kind["forwarded"])
    cut = date(2026, 10, 5)
    summary("  vor 2-min-Prüfung (< 05.10.)", [r for r in by_kind["forwarded"] if (parse_day(r["date"] or r["time"]) or cut) < cut])
    summary("  mit 2-min-Prüfung (ab 05.10.)", [r for r in by_kind["forwarded"] if (parse_day(r["date"] or r["time"]) or cut) >= cut])
    summary("Risiko-Signale (ab 70')", by_kind["risk"])

    print("\n=== 2-Minuten-Prüfung ===")
    summary("bestätigt + gepostet", by_kind["confirmed"])
    summary("verworfen (nicht gepostet)", by_kind["rejected"])
    reasons = defaultdict(list)
    for r in by_kind["rejected"]:
        reason = re.sub(r"\(.*?\)|\d+%? ?<? ?\d*%?|-?\d+", "", r["reason"] or "").strip() or "?"
        reasons[reason].append(r)
    for reason, rows in sorted(reasons.items(), key=lambda kv: -len(kv[1])):
        summary(f"  {reason[:32]}", rows)

    print("\n=== Nach Ziel-Linie (gepostet, High Confidence) ===")
    for line in sorted({to_float(r["target_line"]) for r in by_kind["forwarded"]} - {None}):
        summary(f"O{line}", [r for r in by_kind["forwarded"] if to_float(r["target_line"]) == line])

    print("\n=== Nach Tag (gepostet, High Confidence) ===")
    per_day = defaultdict(list)
    for r in by_kind["forwarded"]:
        per_day[parse_day(r["date"] or r["time"])].append(r)
    for d in sorted(k for k in per_day if k):
        summary(str(d), per_day[d])


if __name__ == "__main__":
    main()
