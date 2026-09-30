# Kalibrierungs-Report – 30.09.2026

Datenbasis: `data/inplayflux_sinyaller_2026-09-20.csv` + `_09-27.csv` + `_09-30.csv`,
**dedupliziert** kombiniert 8.329 Signale (8.311 mit Ergebnis), erzeugt mit
`scripts/analyze_signals.py`. 6.579 Zeilen quer über die drei Exporte waren Duplikate
(rollierendes Fenster) und wurden herausgefiltert.

## Hauptstrategien – aktualisiert mit drittem Export

| Strategie | n (dedupliziert) | Win Rate | Mindestquote | Ø Quote | Puffer |
|---|---:|---:|---:|---:|---:|
| `MoneyBag 2-0/0-2 → Over 2.5` | 3673 | 75,1 % | 1,33x | 1,91 | +0,58 |
| `MoneyBag + 3 Goals → Over 3.5` | 2913 | 69,7 % | 1,43x | 1,90 | +0,47 |
| `Over 2.5 Odd Filter` | 747 | 74,0 % | 1,35x | 1,91 | +0,56 |
| `Over 0.5 Value` | 343 | 72,3 % | 1,38x | 1,91 | +0,53 |
| `MoneyBag 0-0 → Goal` | 172 | 74,4 % | 1,34x | 1,91 | +0,57 |
| `HT over 0.5` | 40 | 57,5 % | 1,74x | 1,94 | +0,20 |

Zahlen für `Over 2.5`/`Over 3.5` fast unverändert gegenüber dem 27.09.-Report (±1pp) –
die dritte Woche bestätigt die bisherigen Zeitverfall-Empfehlungen (`dakika <= 67` bzw. `<= 63`)
ohne Überraschungen. `HT over 0.5` hat weiterhin keine neuen Signale geliefert (immer noch
dieselben 40 wie am 20.09.) – die vorgeschlagene `s5>=3`-Verschärfung bleibt ungetestet.

## Neu: Kalibrierung für `Over 1.5` und `Over 0.5`

Bisher hatte das Tool (`tools/moneybag-analyst.html`) nur ein Modell für O2.5 (Minute-Buckets)
und O3.5 (Minute × Schuss-aufs-Tor-Matrix). Auf Wunsch jetzt ergänzt um O1.5 und O0.5.

### Over 1.5 (drei Bot-Vorlagen-Varianten zusammengeführt)

Die drei Varianten `💰 Over 1.5`, `💰 Over 1.5 cloude`, `💰 Over 1.5 claude 1.änderung` sind
dieselbe zugrundeliegende Strategie unter verschiedenen Regel-Feintuning-Namen (rx-Schwelle,
Schuss-Schwelle) – einzeln wäre jeder Minuten-Bucket zu dünn, daher für das Tool-Modell
zusammengelegt (n=423 gesamt):

| Minute-Bucket | n | Win Rate | Mindestquote |
|---|---:|---:|---:|
| <=61' | 232 | 78,0 % | 1,28x |
| 62-64' | 77 | 70,1 % | 1,43x |
| 65-67' | 54 | 75,9 % | 1,32x |
| 68-71' | 35 | **37,1 %** | 2,69x |
| >=72' | 25 | 92,0 % | 1,09x |

Die 68-71'-Zelle ist kein Rauschen, sondern ein echter Risikobereich – sie liegt zwischen zwei
deutlich stärkeren Nachbar-Zellen und passt zum selben Spätsignal-Zerfall wie bei O2.5/O3.5.
Die >=72'-Zelle (92 %, n=25) ist eine kleine Stichprobe und sollte mit Vorsicht behandelt werden.

### Over 0.5 (`Over 0.5 Value`-Strategie)

Feuert fast ausschließlich bei Minute 61–62:

| Minute-Bucket | n | Win Rate | Mindestquote |
|---|---:|---:|---:|
| <=61' | 280 | 72,9 % | 1,37x |
| >=62' | 63 | 69,8 % | 1,43x |

## Tool-Änderungen

- `calibration/rules.json` → `tool_calibration.o15Buckets` / `o05Buckets` ergänzt, alle
  bestehenden Zahlen auf den 3-Datei-Stand gebracht.
- `tools/moneybag-analyst.html`:
  - Neue Minute-Bucket-Modelle für Ziellinie 1,5 und 0,5 (analog zu O2.5).
  - Parser-Fallback ergänzt, der die Ziellinie auch aus der Kopfzeile lesen kann, wenn die
    "Target:"-Zeile nur generisch "Goal" sagt (typisch für die Over-1.5-Kartenvorlagen).
  - Nebenbei einen bestehenden Bug behoben: der alte generische Zahlen-Fallback konnte bei
    "Target: Goal … 1/2 goals" fälschlich die "1" aus dem Fortschritts-Zähler als Ziellinie
    übernehmen. Er verlangt jetzt eine echte Dezimalzahl (z. B. "2.5"), bevor er etwas rät.
  - Einstellungen-Seite um zwei weitere editierbare Tabellen (O1.5, O0.5) erweitert.
