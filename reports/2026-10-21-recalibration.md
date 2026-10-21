# Neu-Kalibrierung 21.10.2026

**Datenbasis:** alle Exporte bis 21.10.2026, 13.237 entschiedene Signale (05.09.–21.10.,
Halbzeit-Karten ausgenommen). Neuer Export `data/inplayflux_sinyaller_2026-10-21.csv`
(1.624 Szenen 06.10.–21.10., Zeitverschiebung geprüft: 0 min Abweichung bei 824 gemeinsamen
Signalen). Schwellen unverändert (O2.5 0,80 · O3.5 0,75 · O0.5 0,75 · O1.5 0,80, O1.5 bleibt aus).

## Ehrlicher Test auf ungesehenen Tagen (Modell gelernt bis 17.10. abends, geprüft bis 21.10.)

| Linie | Gefiltert | n | Alle neuen Karten | Urteil |
|---|---|---|---|---|
| Over 2.5 | 78,0 % | 82 | 81,2 % (149) | Filter diesmal **schlechter** als der Schnitt |
| Over 3.5 | 74,7 % | 87 | 69,1 % (340) | Filter hilft (+6 pp) |
| Over 0.5 | 93,3 % | 15 | 82,5 % (57) | gut, aber winzige Stichprobe |
| Over 1.5 | 71,4 % | 21 | 73,4 % (109) | zu schwach, bleibt aus |

5-fach CV über alle Daten: O2.5 82,6 % (n=1.481), O3.5 78,2 % (1.000), O0.5 78,8 % (344),
O1.5 74,4 % (121). Stichproben der neuen Tage: ±9 pp (O2.5/O3.5), ±20 pp (O0.5/O1.5).

## Over 3.5: Spielstand und wann das 4. Tor fällt (4.309 Karten, 70,2 %)

| Stand | Treffer | n | Hälften (bis/ab 28.09.) | 4. Tor ≤70' / 71–80' / 81–90' / 90+' | Median Wartezeit |
|---|---|---|---|---|---|
| 3:0 | 73,3 % | 898 | 72,8 / 74,1 | 31 / 31 / 33 / 5 % | 14 min |
| 0:3 | 73,1 % | 539 | 68,8 / 81,9 | 30 / 32 / 34 / 5 % | 14 min |
| 2:1 | 68,2 % | 1.561 | 68,5 / 67,5 | 28 / 33 / 29 / 11 % | 15 min |
| 1:2 | 69,4 % | 1.311 | 69,6 / 69,0 | 29 / 32 / 29 / 10 % | 15 min |

- Klare Führung (3:0/0:3) 73,2 % gegen knapp (2:1/1:2) 68,7 %. Bei knappen Spielen fällt das
  Tor öfter erst in der Nachspielzeit (10–11 % statt 5 %).
- Ob Favorit oder Außenseiter führt: kein Unterschied (70,4 vs 69,8 %).
- Minute zählt am meisten: ≤60' 73,1 %, 61–63' 71,8 %, 64–66' 64,1 %, 67'+ 59,9 %.
- Vor-Spiel-Linie: ≤2,75 66,3 %, 3,0–3,25 72,1 %, ≥3,5 75,2 %.
- Beste Kombination: 3:0/0:3 + Minute ≤63 + Linie ≥3 → 78,2 % (698; Hälften 76,4/81,2).
  Auf den neuen Tagen aber nur 3:0/0:3 72,6 % (106) vs 2:1/1:2 67,5 % (234). Minute und Linie
  stecken schon im Modell; der Spielstand bringt zusätzlich ~+4 pp, wird noch nicht genutzt.

## Halbzeit-Tor-Karten („HT Goal“, 467 Karten, 66,0 %)

- HT Value12 68,6 % (105), HT over 0.5 64,1 % (92), Iy gol 65,6 % (270).
- Minute 0–15' 68,3 % (375), 16–20' 56,5 % (92). HZ-Linie ≥1,5: 71,7 % (145).
- Beste Teilmenge ~72 % → Mindestquote ~1,40; HZ-Tor-Quoten früh im Spiel liegen meist
  darunter. Kein HZ-Spielstand im Export. **Empfehlung: nicht aufnehmen.**

## Over 1.5 (984 Karten, 71,1 %)

- Minute ≤61' 75,9 % (577; Hälften 80,2/73,3), 62–64' 74,3 %, 65–67' 69,9 %, 68'+ 50,0 %.
- Vor-Spiel-Linie ≤2,5 60,4 %, 2,75–3,0 69,7 %, ≥3,25 74,4 %.
- Regel Minute ≤61 + Linie ≥2,75: 76,1 % (522; Hälften 80,9/73,0), neue Tage 75,8 % (91).
- Grenzfall zur 75-%-Regel. Möglich: Testbetrieb mit 0,5 Einheiten, Mindestquote 1,32.
  **Nur nach Entscheidung des Besitzers.**

## Geändert

- `worker/src/index.js`: `CONFIDENCE_MODELS`, `GOAL_SCORE`-Bänder (55 / 63 / 70 / 75 / 81 %).
- `tools/moneybag-analyst.html` und `worker/public/index.html`: `DEFAULT_CALIB`, Badge
  „Kalibriert: 21.10.2026 · 13.237 Signale“.
- `calibration/rules.json`, `calibration/goal_score.json` neu; `scripts/o35_scoreline.py` neu.

18+ · Keine Gewinngarantie · Hilfe: check-dein-spiel.de
