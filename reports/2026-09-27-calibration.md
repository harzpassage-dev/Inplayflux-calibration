# Kalibrierungs-Report – 27.09.2026 (korrigiert)

Datenbasis: `data/inplayflux_sinyaller_2026-09-20.csv` + `data/inplayflux_sinyaller_2026-09-27.csv`,
**dedupliziert** kombiniert 7.928 Signale, erzeugt mit `scripts/analyze_signals.py`.

## Korrektur gegenüber der ersten Version dieses Reports

Die beiden Export-Dateien sind rollierende Fenster und überlappen sich stark im Datumsbereich
(09-20-Export: 05.–20.09., 09-27-Export: 13.–27.09.). **2.072 der 5.000 Zeilen im neuen Export
sind exakt dieselben Signale wie im alten** (gleiches Datum, Spiel, Strategie, Signal-Minute).
Die erste Version dieses Reports hat beide Dateien ungeprüft zusammengezählt (10.000 Signale)
und damit ~2.072 Signale doppelt gewertet. `scripts/analyze_signals.py` dedupliziert jetzt
automatisch beim Kombinieren mehrerer Dateien. Alle Zahlen unten sind die korrigierten.

Am stärksten betroffen war die Aussage zu `HT over 0.5`: Der 09-27-Export enthielt **keine
einzige neue** `HT over 0.5`-Signal — die vermeintlichen "44 Signale, zwei bestätigende Wochen"
waren in Wahrheit dieselben 40 Signale wie im 09-20-Report, plus 4 Duplikate. Die Aussage
"in zwei unabhängigen Wochen bestätigt schwach" war entsprechend falsch. Richtig ist: es gibt
weiterhin nur eine Stichprobe von 40 Signalen.

## Hauptstrategien – Zahlen korrigiert, Empfehlung unverändert

| Strategie | n (dedupliziert) | Win Rate | Mindestquote | Ø Quote | Puffer |
|---|---:|---:|---:|---:|---:|
| `MoneyBag 2-0/0-2 → Over 2.5` | 3493 | 75,6 % | 1,32x | 1,91 | +0,59 |
| `MoneyBag + 3 Goals → Over 3.5` | 2811 | 70,0 % | 1,43x | 1,90 | +0,47 |

Der Zeitverfall-Befund vom 20.09. hält mit größerer (echter) Stichprobe:

- `Over 2.5`: bis Minute 67 überwiegend 65–80 %, danach Einbruch bei 68–70' (69 %, 44 %, 53 %).
  → Empfehlung unverändert: `dakika <= 67`.
- `Over 3.5`: 60-63' stabil (67–77 %), Einbruch bei 64–65' (~63 %), kurze Erholung bei 66–67',
  danach erneuter Abfall. → Empfehlung unverändert: `dakika <= 63`.

## `Over 2.5 Odd Filter`

Neu seit 27.09., **nicht** von der Dedup-Korrektur betroffen (kommt nur im neuen Export vor).
Gleiche Basis-Regel wie `Over 2.5` plus `ouOverOdds >= 1.7`-Filter. Performance (74,4 % WR,
n=696) und Zeitverfall-Muster sind von der Basisstrategie nicht zu unterscheiden.
**Empfehlung:** gleiche Verschärfung wie bei `Over 2.5` (`dakika <= 67`).

## Nebenstrategien (Zahlen korrigiert)

| Strategie | n | Win Rate | Mindestquote | Puffer | Befund |
|---|---:|---:|---:|---:|---|
| `Over 0.5 Value` | 327 | 71,9 % | 1,39x | +0,52 | Nur Minute 61 (72,0 %) / 62 (69,2 %) mit Daten. |
| `MoneyBag 0-0 → Goal` | 150 | 73,3 % | 1,36x | +0,55 | Nur Minute 61 (75,5 %) / 62 (68,6 %) mit Daten. |
| `Over 1.5` | 138 | 73,9 % | 1,35x | +0,56 | 60-64': 76,7 % (n=103); 65-69': 63,2 % (n=19); dünn. |
| `Over 1.5 cloude` | 131 | 74,0 % | 1,35x | +0,49 | 60-64': 78,0 % (n=91), danach abfallend, dünn. |
| `Over 1.5 claude 1.änderung` | 132 | 76,5 % | 1,31x | +0,52 | Beste der drei Varianten, hält sich auch bei 65-69' (78,3 %, n=23). |
| `HT over 0.5` | 40 | 57,5 % | 1,74x | +0,20 | Weiterhin nur eine Stichprobe, siehe unten. |

Keine Regeländerung für die `Over 0.5`/`Over 1.5`-Varianten — Datenlage weiterhin zu dünn
jenseits der ersten 1–3 Minuten des jeweiligen Regel-Fensters.

## `HT over 0.5` – Regel überarbeitet

Mit nur 40 Signalen lässt sich kein belastbares Modell trainieren — aber eine gezielte Suche
nach besseren Schwellenwerten in den vorhandenen Merkmalen (Radar X Score, Schüsse gesamt,
Schüsse in den letzten 5 Minuten) zeigt einen Kandidaten:

| Filter | n | Win Rate |
|---|---:|---:|
| Aktuelle Regel (`s5 >= 2`) | 40 | 57,5 % |
| `s5 >= 3` (Schüsse letzte 5 Min.) | 18 | 66,7 % |
| `rx >= 145` (nur als Vergleich, nicht empfohlen) | 21 | 66,7 % |
| `rx >= 155,5` (nur als Vergleich, nicht empfohlen) | 13 | 84,6 % |

**Empfehlung:** `s5`-Schwelle von `>= 2` auf `>= 3` anheben:

```
dakika <= 20 | dakika >= 10 | maviBomba = 1 | rx <= 178 | s5 >= 3 | toplamGol <= 1 | toplamSut >= 3 | vanPersie = 1
```

**Wichtige Einschränkung:** Das ist eine Hypothese aus einer einzigen 40er-Stichprobe, keine
validierte Lösung. Die `rx`-Schwellen sehen in der Tabelle verlockender aus, aber bei n=13–21
ist das im Rauschen — deshalb nicht empfohlen. `s5 >= 3` ist der einzige Filter, der bei einer
noch halbwegs vertretbaren Stichprobengröße (n=18, 45 % des Datensatzes) eine klare
Verbesserung zeigt. Nach den nächsten 1–2 Exporten unbedingt erneut prüfen, ob sich die 66,7 %
halten. Falls nicht: Strategie braucht einen härteren Blick auf andere Merkmale oder sollte
eingestellt werden.

## Radar X Score & Market Drop %

Radar X Score weiterhin kein starker Zusammenhang (72–75 % über alle Buckets). Market Drop %
zeigt kein klares monotones Muster (71–74 % bis 20 %, Einbruch bei 20–30 % auf 66,1 % n=183,
dann wieder 72,8 % bei ≥30 % n=254) — bei diesen Stichprobengrößen noch nicht aktionabel.

## Nächste Schritte

1. `dakika <= 67` (Over 2.5 / Over 2.5 Odd Filter) und `dakika <= 63` (Over 3.5) in die
   Live-Regeln übernehmen.
2. `HT over 0.5`: `s5 >= 3` testweise scharfschalten und nach dem nächsten Export prüfen, ob
   die 66,7 % Win Rate hält.
3. Bei den `Over 0.5`/`Over 1.5`-Varianten: nichts ändern, weiter beobachten.
4. `tools/moneybag-analyst.html`-Kalibrierung (`DEFAULT_CALIB`) ist noch auf dem Stand vom
   20.09. — Re-Sync steht aus.
5. Künftige Kombinationen mehrerer Exporte laufen jetzt automatisch dedupliziert über
   `scripts/analyze_signals.py` — keine manuelle Prüfung auf Überlappung mehr nötig.
