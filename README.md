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
- `scripts/fetch_odds.py` – CLI to pull live/pre-match odds (1X2, Over/Under)
  from [The Odds API](https://the-odds-api.com/) for a given league, used to
  cross-check the Mindestquote against real market odds. Requires
  `ODDS_API_KEY` as an environment variable (never hardcode it).
- `scripts/live_radar.py` – live radar: pulls the scanner feed that
  inplayflux.com's live table loads (`maclarv8/GETAllMatches.php`, plain
  JSON, no login needed), checks every running match against the strategy
  rules and scores each hit with the same confidence models the worker
  uses (`live_confidence_models`) plus the minute buckets
  (`tool_calibration`). Verdict per signal: PREMIUM / OK / RISIKO, with
  Mindestquote and edge vs. the live Over quote. `--watch`/`--log` keeps
  polling (min. 30 s) and settles each logged signal as won/lost.
- `scripts/goal_drivers.py` – why and when the next goal falls after a
  signal: reconstructs the Radar X formula, measures goal timing and the
  conditions that shift the goal rate (validated on an older vs. newer time
  window) and writes the points-based goal score to
  `calibration/goal_score.json`, which `live_radar.py` shows per match.
  Needs `pandas` and `scikit-learn`. See `reports/2026-10-05-goal-drivers.md`.
- `scripts/premium_report.py` – premium-channel hit rates: joins the
  worker's premium log (admin panel → "Log als CSV exportieren") with
  signal exports that carry results; reports posted vs. rejected signals of
  the 2-minute live check, per target line and per day.
- `worker/` – Cloudflare Worker that gates `tools/moneybag-analyst.html`
  behind time-limited access tokens (24h trial links, manually extended
  after payment). See `worker/README.md` for deploy and admin usage.

Notfall-Wiederherstellung und Backups: siehe `RESTORE.md`.

## Usage

```bash
python3 scripts/analyze_signals.py data/inplayflux_sinyaller_2026-09-20.csv
python3 scripts/analyze_signals.py data/*.csv  # mehrere Exporte kombiniert auswerten

python3 scripts/goal_drivers.py               # Tor-Treiber + Tor-Score neu berechnen
python3 scripts/live_radar.py                 # Live-Snapshot aller Signale
python3 scripts/live_radar.py --watch 60 --log data/live_radar_log.csv

export ODDS_API_KEY="dein_key"
python3 scripts/fetch_odds.py --sports                       # Ligen auflisten (0 Credits)
python3 scripts/fetch_odds.py soccer_chile_campeonato "Colo"  # Quoten für ein Spiel
```
