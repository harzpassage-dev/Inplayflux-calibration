# InPlayFlux Calibration

Tools and reports for calibrating InPlayFlux live-betting signal strategies
(e.g. `MoneyBag`, `Over X.5`) against historical signal exports.

## Layout

- `data/` – raw signal exports (CSV) from InPlayFlux.
- `scripts/analyze_signals.py` – computes win-rate breakdowns by strategy,
  signal minute, radar score, and market drop %.
- `calibration/rules.json` – current vs. recommended rule thresholds per
  strategy, derived from the analysis.
- `reports/` – dated write-ups of calibration findings.

## Usage

```bash
python3 scripts/analyze_signals.py data/inplayflux_sinyaller_2026-09-20.csv
```
