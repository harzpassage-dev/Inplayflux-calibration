# Wochen-Routine 07.11.2026 (Export 11-07)

- Export `data/inplayflux_sinyaller_2026-11-07.csv` (3.849 Zeilen, 23.10.–07.11., Zeitverschiebung 0), alle Daten: 16.828 entschiedene Signale.
- Modelle neu angepasst (`scripts/recalibrate.py --write`), Schwellen unverändert. Tor-Score-Punkte **nicht** übernommen
  (Skript schlug min_63_65 −4→−5 und recent_goal −1→0 vor, AUC auf neuem Zeitraum nur 0,584 – zu kleine Änderung).
- Neue Tage = nach dem letzten Signal des Exports 11-02 (02.11. 17:54 – 07.11. 08:23), Modell nur bis 02.11. gelernt.

| Stufe | gefiltert | n | roh | Urteil |
|---|---|---|---|---|
| High Confidence O2.5 (≥ 0,80) | 83,8 % | 74 | 83,9 % (137) | behalten; Filter bringt diese Woche nichts über roh |
| High Confidence O3.5 (≥ 0,75) | 81,8 % | 55 | 75,0 % (128) | behalten |
| High Confidence O0.5 (≥ 0,75) | 87,5 % | 24 | 73,4 % (169) | behalten |
| O0.5 2 Einheiten (Linie ≥ 4) | 7 von 7 Spielen | 7 | – | behalten (klein) |
| O1.5-Modell (aus) | 100 % | 27 | 80,2 % (182) | bleibt aus (zu klein, vor 2 Wochen 68,7 %) |
| 🧪 Over 1.5 Test (Min ≤ 61, Linie ≥ 3,75, Männer) | 83,3 % (Spiele) | 12 | – | zu klein; Entscheidung Montag mit echten Quoten |
| alte O1.5-Regel (Linie ≥ 2,75) zum Vergleich | 78,2 % (Spiele) | 78 | – | – |
| Half-Risiko 68–69' | – | 0 | – | keine Karten |

O1.5 nach Strategie (neue Tage, Karten): Over 1.5 Value 82 % (74), ValueShots15 82 % (33), Money Bag Over 1.5 77 % (75).

Wichtig: Trefferquoten aus dem Export sagen nichts über den Gewinn. Ob eine Stufe Geld bringt, zeigen nur die echten
Quoten (Ergebnis-CSV, Beta-Kanal) – das wird am Montag 09.11. geprüft.

Daten der Woche (Startseite): noch ein Tor nach ~60' nach Ballbesitz-Unterschied (`scripts/possession_stats.py`,
8.234 Spiele): < 10 Punkte 74 %, 10–19 75 %, 20–29 73 %, ≥ 30 79 % (Hälften 79/78).
