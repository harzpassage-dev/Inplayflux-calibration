# Neu-Kalibrierung 17.10.2026

**Datenbasis:** alle Exporte bis 17.10.2026, 12.582 entschiedene Signale (Halbzeit-Karten
ausgenommen, 338 Szenen). Neuer Export `data/inplayflux_sinyaller_2026-10-17.csv`
(3.894 Szenen 02.10.–17.10., Zeitverschiebung +1 h gegen den 10.10.-Export geprüft: 0 min
Abweichung bei 2.578 gemeinsamen Signalen).

## Ehrlicher Test auf ungesehenen Tagen (Modell gelernt bis 10.10., geprüft 11.–17.10.)

| Linie | Schwelle | Treffer | n | Alle Karten dieser Linie | Urteil |
|---|---|---|---|---|---|
| Over 2.5 | 0,80 | 81,9 % | 182 | 81,6 % (353) | hält, filtert aber kaum besser als der Schnitt |
| Over 0.5 (Tor bei 0:0) | 0,75 | 78,3 % | 83 | 69,1 % (433) | hält, deutlich besser als der Schnitt |
| Over 1.5 | 0,80 | 70,0 % | 30 | 65,9 % (226) | **zu schwach** (Mindestquote wäre 1,43) |
| Over 3.5 | 0,75 | – | 0 | – | seit 10.10. keine Karten mehr |

Kleine Stichproben: ±7 pp (O2.5), ±9 pp (O0.5), ±17 pp (O1.5).

## Befunde

1. **Halbzeit-Karten** („HT Goal“, „Iy gol“, „HT over 0.5“, Minute 1–20) waren in allen
   Modellen enthalten, obwohl sie auf ein Tor vor der Pause wetten. Mit ihnen fiel Over 1.5 auf
   den neuen Tagen auf 58 % (n=62). Sie sind jetzt aus allen Auswertungen raus
   (`scripts/goal_drivers.py` `load`), und der Worker ignoriert solche Karten.
2. **Over 1.5** hält die versprochenen ~80 % nicht, auch letzte Woche schon nicht (76 %).
   Premium und Half-Risiko für Over 1.5 sind **abgeschaltet** (`LINES_OFF` im Worker).
   Wieder einschalten erst, wenn eine neue CSV ≥ 75 % auf ungesehenen Tagen zeigt.
3. **Half-Risiko (68–69')**: keine neuen Karten in diesem Minutenfenster, `HALF_WR` (0,65)
   bleibt.
4. **Tor-Score** neu: Minute ≥ 66 jetzt −8 (vorher −7); Bänder 55 / 64 / 70 / 75 / 81 %.

## Geändert

- `worker/src/index.js`: `CONFIDENCE_MODELS`, `GOAL_SCORE`, `LINES_OFF = {1.5}`,
  Halbzeit-Filter im Karten-Parser.
- `tools/moneybag-analyst.html` und `worker/public/index.html`: `DEFAULT_CALIB`, Badge
  „Kalibriert: 17.10.2026 · 12.582 Signale“.
- `calibration/rules.json`, `calibration/goal_score.json` neu geschrieben.

18+ · Keine Gewinngarantie · Hilfe: check-dein-spiel.de
