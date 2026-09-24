# InPlayFlux Calibration

Tools and reports for calibrating InPlayFlux live-betting signal strategies
(e.g. `MoneyBag`, `Over X.5`) against historical signal exports.

## Layout

- `data/` – raw signal exports (CSV) from InPlayFlux.
- `scripts/analyze_signals.py` – computes win-rate breakdowns by strategy,
  signal minute, radar score, and market drop %, plus the break-even odds
  (Mindestquote = 1 / win rate) each one requires to stay profitable.
- `calibration/rules.json` – current vs. recommended rule thresholds per
  strategy, derived from the analysis.
- `reports/` – dated write-ups of calibration findings.
- `tools/moneybag-analyst.html` – standalone offline calculator (paste a
  signal card, get Poisson/bucket-model/market-implied win probabilities
  and edge vs. a live quote). No build step; open the file directly or
  serve it via GitHub Pages. Calibration values inside it should be kept
  in sync with `calibration/rules.json` after each analysis run.

## Usage

```bash
python3 scripts/analyze_signals.py data/inplayflux_sinyaller_2026-09-20.csv
```
