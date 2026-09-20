# Kalibrierungs-Report – 20.09.2026

Datenbasis: `data/inplayflux_sinyaller_2026-09-20.csv`, 5.000 Signale, erzeugt mit `scripts/analyze_signals.py`.

## Gesamtbild

- Gesamt-Trefferquote: **73,3 %**
- Zwei Strategien decken ~88 % des Volumens ab:
  - `MoneyBag 2-0/0-2 → Over 2.5`: n=2455, **76,0 %**
  - `MoneyBag + 3 Goals → Over 3.5`: n=1955, **69,9 %**

## Mindestquote (Break-even-Odds)

Formel: `Mindestquote = 1 / Win Rate`. Das ist die Dezimalquote, die eine
Strategie im Schnitt mindestens braucht, damit die Gewinne die Verluste
ausgleichen. Liegt die real erzielte Quote darunter, rutscht die Strategie
auf Dauer ins Minus, auch wenn die Win Rate hält.

| Strategie | n | Win Rate | Mindestquote | Ø erzielte Over-Quote | Puffer |
|---|---:|---:|---:|---:|---:|
| `MoneyBag 2-0/0-2 → Over 2.5` | 2455 | 76,0 % | **1,31x** | 1,91 | +0,60 |
| `MoneyBag + 3 Goals → Over 3.5` | 1955 | 69,9 % | **1,43x** | 1,90 | +0,47 |
| `Over 0.5 Value` | 222 | 73,4 % | **1,36x** | 1,92 | +0,56 |
| `💰 Over 1.5` | 99 | 74,7 % | **1,34x** | 1,91 | +0,57 |
| `HT over 0.5` | 40 | 57,5 % | **1,74x** | 1,94 | +0,20 |

Alle Strategien erzielen im Schnitt deutlich höhere Quoten (1,85–1,94) als
ihre Mindestquote erfordert – aktuell gibt es also überall Luft. Am
knappsten ist der Puffer bei `HT over 0.5` (+0,20), die ohnehin schwächste
Strategie im Report.

**Zeitverfall in Mindestquote-Sicht:** Da die Win Rate mit der Signal-Minute
fällt, steigt die Mindestquote entsprechend an:

| Signal-Minute | Win Rate | Mindestquote |
|---|---:|---:|
| < 57 | 77,5 % | 1,29x |
| 57–59 | 75,1 % | 1,33x |
| 60–64 | 72,6 % | 1,38x |
| 65–69 | 64,7 % | 1,55x |
| ≥ 70 | 62,6 % | 1,60x |

Späte Signale (≥ 65') brauchen also spürbar höhere Quoten (1,55x–1,60x
statt 1,29x–1,38x früh), um nicht ins Minus zu laufen. Das ist ein
zusätzliches Argument für die unten empfohlene engere `dakika`-Obergrenze:
je später das Signal, desto weniger Puffer bleibt zur real verfügbaren
Quote.

**Mindestquote pro Strategie × Zeitfenster (n ≥ 15):**

| Strategie | Zeitfenster | n | Win Rate | Mindestquote | Ø Over-Quote | Puffer |
|---|---|---:|---:|---:|---:|---:|
| `Over 2.5` | < 57' | 1826 | 78,0 % | 1,28x | 1,91 | +0,63 |
| `Over 2.5` | 57–59' | 177 | 75,1 % | 1,33x | 1,92 | +0,59 |
| `Over 2.5` | 60–64' | 220 | 72,7 % | 1,38x | 1,93 | +0,55 |
| `Over 2.5` | 65–69' | 143 | 65,0 % | 1,54x | 1,89 | +0,35 |
| `Over 2.5` | ≥ 70' | 89 | 64,0 % | 1,56x | 1,90 | +0,34 |
| `Over 3.5` | 60–64' | 1559 | 71,6 % | 1,40x | 1,91 | +0,51 |
| `Over 3.5` | 65–69' | 291 | 62,9 % | 1,59x | 1,89 | +0,30 |
| `Over 3.5` | ≥ 70' | 105 | 62,9 % | 1,59x | 1,90 | +0,31 |
| `HT over 0.5` | < 57' | 40 | 57,5 % | 1,74x | 1,94 | +0,20 |

(vollständige Tabelle inkl. kleinerer Nebenstrategien: `scripts/analyze_signals.py` Abschnitt "strategy x signal-minute bucket"; `calibration/rules.json` → `breakeven_odds_by_strategy_and_signal_minute`)

Der Puffer schrumpft in beiden Hauptstrategien mit steigender Signal-Minute
deutlich (`Over 2.5`: +0,63 → +0,34; `Over 3.5`: +0,51 → +0,30). Bei den
real beobachteten Durchschnittsquoten (~1,89–1,93) rutscht noch keine
Kombination ins Minus, aber die späten Fenster haben spürbar weniger
Sicherheitsabstand – schon eine kleine Quotenverschlechterung oder ein
leichter Rückgang der Win Rate würde dort zuerst kippen.

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

## Validierungsfall (Live-Signal, 20.09.2026)

Live-Signal zur Kontrolle gegen die neue Kalibrierung geprüft:

> 💰 MoneyBag 2-0/0-2 → Over 2.5 · Japan League Cup Women ·
> Urawa Red Diamonds (W) 1–1 Omiya Ardija (W) · Signal-Minute 57' ·
> Radar X 318 · Regeln: `dakika <= 73`, `dakika >= 55`, Monetary Change aktiv, `toplamGol = 2`

Einordnung:

- **Signal-Minute 57'** liegt im starken frühen Fenster (55–67), historisch 83,1 % Trefferquote genau bei Minute 57 (n=71). Die empfohlene neue Obergrenze `dakika <= 67` hätte dieses Signal weiterhin durchgelassen – kein Grenzfall.
- **Radar X 318** liegt im mittleren 300–350-Bucket (historisch 73,8 % WR), keine Auffälligkeit.
- Regel-Match nach alter und neuer Kalibrierung identisch (55 ≤ 57 ≤ 67/73, `toplamGol = 2`, Monetary Change aktiv).

Fazit: Signal bestätigt die Zeitverfall-These, statt sie zu widerlegen – ein Signal im "guten" Fenster bleibt unter der verschärften Regel erhalten.

## Nächste Schritte

1. Neue `dakika`-Grenzwerte aus `calibration/rules.json` in die Live-Regeln übernehmen.
2. `HT over 0.5` beobachten oder deaktivieren (kleinster Quoten-Puffer, +0,20).
3. Real erzielte Quoten laufend gegen die Mindestquote pro Strategie/Zeitfenster prüfen, nicht nur einmalig – der Puffer ist aktuell komfortabel, aber quotenabhängig.
4. Weitere Signal-Exporte mit `scripts/analyze_signals.py` auswerten, um die Zeitverfall-These zu bestätigen und die Cutoffs weiter zu verfeinern.

## Annahmen zur Mindestquote

- Mindestquote geht von gleicher Einsatzhöhe je Signal aus (Flat Stake), ohne Berücksichtigung von Gebühren/Steuern auf Gewinne.
- Basis ist die historische Win Rate der 5.000 Signale vom 20.09.2026 – kein Garant für künftige Quoten oder Trefferquoten. Bei Rückfragen zur Methodik oder abweichenden Annahmen (z. B. gestaffelte Einsätze) bitte melden.
