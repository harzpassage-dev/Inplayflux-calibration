---
name: wochen-routine
description: Weekly routine for a new InPlayFlux CSV export (the owner uploads it, usually Mondays after the bot's "Wochen-Check" message) – recalibrate, test every tier on the unseen days, switch weak tiers off, report in German.
---

# Wochen-Routine (new InPlayFlux export)

Use when the owner uploads a raw `inplayflux_sinyaller_*.csv` (or says "neue CSV", "Wochen-Routine",
"neue Kalibrierung"). Answer in German, short, small tables, sample sizes, say what was out-of-sample.

## 1. Run everything in one go

```
python3 scripts/weekly.py <path to uploaded raw CSV>
```

It stops if the time shift against the previous export is not 0 (then try `--shift-min` with
`scripts/normalize_export.py` by hand). Otherwise it writes `data/inplayflux_sinyaller_<date>.csv` and
`reports/<date>-wochen-check.txt` (all analyses) and prints the time-test lines (models fitted up to the
previous export's last signal, tested on the new days).

## 2. Decide per tier (new days only, say n)

| Tier | Keep if | Else |
|---|---|---|
| High Confidence per line | filtered ≥ raw rate of that line and ≥ ~75 % (O2.5 ≥ 78 %) | raise threshold (`--threshold LINE=X`) or add the line to `LINES_OFF` |
| 🧪 Over 1.5 Test | rule (min ≤ 61, line ≥ 2.75) ≥ ~72 % | `O15_TEST_ENABLED = false` |
| O0.5 2 units (line ≥ 4) | ≥ ~88 % | set `O05_STRONG_LINE` higher or remove |
| Half-Risiko | ≥ 62 % at 68–69' | switch off |

Also read admin "Ergebnisse" numbers the owner sends (market comparison, 1.40-wait profit): a tier with
negative market points over ≥ 50 tips loses money even at a good hit rate → stricter or off.
Never switch a tier on/off without telling the owner; changes that add risk (more stake, new tier) need
the owner's yes.

## 3. Apply (only after the checks)

1. `python3 scripts/recalibrate.py data/*.csv --write` (keep thresholds unless step 2 says otherwise).
2. `python3 scripts/goal_drivers.py data/*.csv` (rewrites `calibration/goal_score.json`).
3. Copy `CONFIDENCE_MODELS` and the goal score bands into `worker/src/index.js`; update the comment
   with the unseen-day numbers.
4. Tool `DEFAULT_CALIB` + badge "📅 Kalibriert: <date> · <n> Signale" in **both**
   `worker/public/index.html` and `tools/moneybag-analyst.html` (keep identical: `cmp` them).
5. `node --check worker/src/index.js`, `node --test "worker/test/*.test.mjs"` (add or adjust a test for
   anything that changed in the worker), `cd worker && npx wrangler deploy --dry-run`.
6. German report `reports/<date>-recalibration.md` (table: tier, filtered %, n, raw %, verdict);
   CLAUDE.md change log + open items.
7. Commit (trailers from the system reminder), push to `claude/page-radar-signal-analysis-bdok65`,
   verify live (`/?t=premium:pending` → 403, `/admin` has `x-frame-options: DENY`).

## 4. Tell the owner

Short German summary: date + signal count, per-tier table (new days), what was switched on/off and why,
what to watch next week. No promises; "18+ · Keine Gewinngarantie" only where marketing text is written.

## 5. Rollback (owner thinks the last calibration was worse)

1. Compare first, on cards neither model has seen:
   `python3 scripts/compare_models.py <commit before the recalibration>^ "<deploy time of the recalibration>" [new raw export, normalized]`
   (old vs new `CONFIDENCE_MODELS` on the same cards, one per match + line). If the two differ by < ~3 pp or n < 50,
   the models are not the cause – look at the tiers without a model (Over 1.5 Test) and at voids instead.
2. Only if the old models are clearly better: restore the old `CONFIDENCE_MODELS` (and goal score bands) from
   `git show <commit>^:worker/src/index.js`, keep everything else, run the checks, push, note it in CLAUDE.md.
   Every calibration stays in git, so any earlier version can be restored the same way within minutes.

## 6. "Daten der Woche" on the start page (every weekly routine)

Replace `DATEN_DER_WOCHE` in `worker/src/index.js` (date, title, 2-sentence German text, 3–4 bars [label, %, n], basis)
with one new own analysis from `data/*.csv`: count unique matches, show only groups with n ≥ ~80 that hold in both halves
of the period, no gain promises, no betting jargon beyond "Tor-Erwartung"/"Markt". Re-use the TikTok scripts in `scripts/`
or write a new `scripts/*_stats.py`. Keep the test "Daten der Woche" passing (4 bars, or adjust it with the bar count).
