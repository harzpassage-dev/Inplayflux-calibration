#!/usr/bin/env python3
"""Normalize a raw InPlayFlux CSV export into data/inplayflux_sinyaller_<date>.csv.

Since 2026-10-06 the export writes the date as ="DD/MM/YYYY, hh:mm:ss" (the comma splits it
into two columns) and one hour early. This joins the columns, adds the hour (check it with
--check-against <previous export>, which prints the time shift on overlapping signals) and
writes ="YYYY-MM-DD hh:mm:ss" like the older exports.

  python3 scripts/normalize_export.py RAW.csv --check-against data/<previous>.csv
  python3 scripts/normalize_export.py RAW.csv --write
"""
import argparse, csv, datetime as dt, re, sys
from collections import Counter

ap = argparse.ArgumentParser()
ap.add_argument("raw")
ap.add_argument("--shift-min", type=int, default=60)
ap.add_argument("--check-against")
ap.add_argument("--write", action="store_true")
a = ap.parse_args()

rows = list(csv.reader(open(a.raw, encoding="utf-8-sig")))
head, body = rows[0], rows[1:]
if body and len(body[0]) == len(head) + 1:
    body = [[x[0] + "," + x[1]] + x[2:] for x in body]
assert {len(x) for x in body} == {len(head)}, "unexpected column count"
clean = lambda v: re.sub(r'[="]', "", v).strip()
ts = [dt.datetime.strptime(clean(x[0]), "%d/%m/%Y, %H:%M:%S") + dt.timedelta(minutes=a.shift_min) for x in body]
print(f"{len(body)} rows, {min(ts)} .. {max(ts)} (after +{a.shift_min} min)")

if a.check_against:
    old = {}
    for x in list(csv.reader(open(a.check_against, encoding="utf-8-sig")))[1:]:
        old.setdefault((x[1], x[3], x[4]), []).append(dt.datetime.strptime(clean(x[0]), "%Y-%m-%d %H:%M:%S"))
    diff = Counter(round((o - t).total_seconds() / 60) for x, t in zip(body, ts)
                   for o in old.get((x[1], x[3], x[4]), []) if abs((o - t).total_seconds()) <= 3 * 3600)
    print("remaining shift vs previous export (minutes: count):", diff.most_common(3), "-> 0 means correct")

if a.write:
    out = f"data/inplayflux_sinyaller_{max(ts).date()}.csv"
    with open(out, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(head)
        for x, t in zip(body, ts):
            w.writerow([f'="{t:%Y-%m-%d %H:%M:%S}"'] + x[1:])
    print("written", out)
