# Kalibrierungs-Report – 20.09.2026

Datenbasis: `data/inplayflux_sinyaller_2026-09-20.csv`, 5.000 Signale, erzeugt mit `scripts/analyze_signals.py`.

## Gesamtbild

- Gesamt-Trefferquote: **73,3 %**
- Zwei Strategien decken ~88 % des Volumens ab:
  - `MoneyBag 2-0/0-2 → Over 2.5`: n=2455, **76,0 %**
  - `MoneyBag + 3 Goals → Over 3.5`: n=1955, **69,9 %**

## Zeitverfall (wichtigster Befund)

Die Trefferquote fällt mit steigender Signal-Minute:

| Signal-Minute | Trefferquote |
|---|---|
| < 57 | 77,5 % |
| 57–59 | 75,1 % |
| 60–64 | 72,6 % |
| 65–69 | 64,7 % |
| ≥ 70 | 62,6 % |

Pro Strategie:

- `Over 2.5`: stabil 72–83 % für Minuten 55–67, fällt danach (Minute 68–73) auf 46–67 %.
- `Over 3.5`: stabil 66–78 % für Minuten 60–63, fällt danach (Minute 64–71) meist auf 55–68 %.

**Empfehlung:** obere `dakika`-Grenze in den Regeln verschärfen (siehe `calibration/rules.json`):
- `Over 2.5`: `dakika <= 73` → `dakika <= 67`
- `Over 3.5`: `dakika <= 71` → `dakika <= 63`

Das reduziert Volumen, erhöht aber die Precision der späten (schwächeren) Signale nicht mehr durchmischt mit den frühen (starken).

## Radar X Score

Kein starker monotoner Zusammenhang: 71–75 % Trefferquote über alle Buckets (`<200` bis `>=450`). Der Score taugt aktuell kaum als eigenständiger Filter – das Signal-Timing ist der stärkere Prädiktor.

## Market Drop %

Weitgehend flach (69–74 %) bis 30 % Drop, springt danach auf 80,3 % (n=142, kleine Stichprobe – beobachten, noch nicht aktionabel).

## Schwache Nebenstrategie

`HT over 0.5`: nur 57,5 % (n=40), deutlich unter dem Rest. Kandidat zum Entfernen oder Nachschärfen der Regel, Stichprobe aber klein.

## Nächste Schritte

1. Neue `dakika`-Grenzwerte aus `calibration/rules.json` in die Live-Regeln übernehmen.
2. `HT over 0.5` beobachten oder deaktivieren.
3. Weitere Signal-Exporte mit `scripts/analyze_signals.py` auswerten, um die Zeitverfall-These zu bestätigen und die Cutoffs weiter zu verfeinern.
