# Neukalibrierung 10.10.2026

Datenbasis: alle sechs Exporte in `data/`, dedupliziert, **11.610 entschiedene Signale**
(05.09.–10.10.2026). Der neue Export `inplayflux_sinyaller_2026-10-10.csv` kam im selben
Format wie der vom 06.10.: Datum als `TT/MM/JJJJ, hh:mm:ss`, durch das Komma in zwei Spalten
zerfallen, und eine Stunde früher. Er wurde ins bisherige Format gebracht (+1 h, 3.962 Zeilen
stimmen danach mit dem 06.10.-Export überein). **803 Signale sind neu** (06.10. 18 Uhr bis
10.10.).

Neu: `scripts/recalibrate.py` erzeugt die Premium-Modelle und die Tool-Tabellen
reproduzierbar (5-fach-Kreuzvalidierung plus Zeit-Test).

## 1. Wie haben die alten Regeln auf den neuen Tagen abgeschnitten?

| neu, 06.–10.10. | n | Treffer | vorher (bis 06.10.) |
|---|---:|---:|---:|
| alle Signale | 803 | 73,0 % | 72,8 % |
| High Confidence (altes Modell) | 245 | **76,3 %** | 81,0 % |
| Risiko (ab 70') | 20 | **40,0 %** | 64,8 % |
| Half-Risiko (68–69') | 1 | – | 66,3 % |
| Over 0.5 High Confidence | 24 | 79,2 % | 75,6 % |

High Confidence lag rund 5 Punkte unter dem Erwartungswert. Auffällig am 09./10.10.: viele Spiele
mit sehr hoher Vorab-Linie (Ø 3,5 statt 3,0). Das Modell wertet sie als stark, sie trafen aber
nur zu 70,7 % (n = 147, historisch 78,6 %). Zwei Tage sind zu wenig, um das als neuen Trend
zu werten. Es bleibt aber zu beobachten.

Die Risiko-Stufe hatte schwache Tage (8 von 20). Insgesamt liegt sie jetzt bei 62,8 % (n = 258).

## 2. Neue Modelle (5-fach-Kreuzvalidierung, alle Daten)

| Linie | Schwelle | Treffer | Anteil der Signale |
|---|---:|---:|---:|
| O2.5 | 0,80 | 83,1 % | 19,6 % |
| O3.5 | 0,75 | 78,8 % | 23,5 % |
| O1.5 | 0,80 | 84,3 % | 13,2 % |
| **O0.5** | **0,75** (vorher 0,80) | **80,8 %** | 25,5 % |

Zeit-Test (gelernt bis 06.10., geprüft auf den neuen Tagen): O2.5 75,8 % (n = 99),
O3.5 77,4 % (n = 84).

**Over 0.5:** Das alte Modell war fast nur auf „Over 0.5 Value“ gelernt. Die Karten von
„MoneyBag 0-0 → Goal“ kamen ja bis zum 08.10. gar nicht im Worker an. Neu gelernt auf beiden
Strategien (n = 982) trennt es deutlich besser: Schwelle 0,75 bringt 80,8 % statt 75,6 %,
bei ähnlicher Menge.

## 3. Tor-Score

Neu gelernt auf allen Daten. Zwei Punkte haben sich verschoben: Minute 63–65 −5 → −4,
starke Abwehren −2 → −1. Die Bänder halten weiter (≥ +1: 81,3 %, ≤ −9: 53,7 %).
Validierungs-AUC 0,596 (vorher 0,606).

## 4. Umgesetzt

- `calibration/rules.json`: neue Modelle und Tool-Tabellen, Quellen, Anzahl.
- `calibration/goal_score.json`: neue Punkte und Bänder.
- Worker:
  - `CONFIDENCE_MODELS` neu, Schwelle O0.5 0,75;
  - `GOAL_SCORE` neu;
  - Mindestquote Risiko aus 62,8 % (1,60), Half-Risiko aus 65,0 % (1,54).
- Analyse-Tool: Bucket-Tabellen neu. Wer im Tool eigene Einstellungen gespeichert hat,
  behält diese, bis er sie zurücksetzt.

## Beobachten

- High Confidence live gegen den Erwartungswert, besonders bei Vorab-Linie ≥ 3,5.
- Risiko-Stufe: Fallen die nächsten 30–40 Signale wieder unter 55 %, sollte sie pausieren.
- Markt-Grenze (60 %) mit den ersten Live-Logs prüfen.
