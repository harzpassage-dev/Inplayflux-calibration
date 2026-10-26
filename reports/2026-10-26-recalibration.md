# Wochen-Check & Neukalibrierung 26.10.2026

Export `data/inplayflux_sinyaller_2026-10-26.csv` (2.483 Zeilen, 11.10.–26.10., Zeitversatz 0).
Alle Exporte zusammen: **14.432 entschiedene Signale** (HT-Karten ausgeschlossen). Volle Auswertung:
`reports/2026-10-26-wochen-check.txt`.

## Neue Tage (24.10. 11:16 – 26.10. 17:21), Modell nur bis 24.10. gelernt = ungesehen

| Stufe | Gefiltert | n | Roh (alle Karten) | n | Urteil |
|---|---|---|---|---|---|
| 🔥 O2.5 (≥ 0,80) | 79,5 % | 117 | 78,5 % | 209 | bleibt (≥ 78 %, knapp über roh) |
| 🔥 O3.5 (≥ 0,75) | 88,0 % | 108 | 79,8 % | 228 | bleibt, stark |
| 🔥 O0.5 (≥ 0,75) | 82,4 % | 17 | 72,7 % | 77 | bleibt (kleine Zahl) |
| O1.5-Modell (≥ 0,80) | 68,7 % | 67 | 70,9 % | 337 | bleibt aus (`LINES_OFF`) |
| 🧪 Over 1.5 Test (Min ≤ 61, Linie ≥ 2,75) | 73,5 % | 291 | – | – | bleibt, knapp über 72 % |
| – davon Money Bag Over 1.5 | 75,3 % | 154 | | | |
| – davon Over 1.5 Value | 72,3 % | 94 | | | |
| – davon Over 1.5 ValueShots15 | 69,8 % | 43 | | | schwächste, Kandidat zum Abschalten |
| O0.5 2 Einheiten (Linie ≥ 4) | 75,0 % | 8 | | | zu wenig Daten (langfristig 93,5 %, n=107), bleibt |
| 🟠 Half-Risiko (68–69') | – | 0 | | | keine Karten in dem Zeitraum |

Alle 77 0:0-Karten kamen von „Over 0.5 Value“ – „MoneyBag 0-0 → Goal“ ist weiter aus.

## Kreuzvalidierung (alle Daten, 5-fach, an der Schwelle)

| Linie | Treffer | n | Grundquote |
|---|---|---|---|
| O2.5 | 82,5 % | 1.638 | 75,5 % |
| O3.5 | 79,4 % | 1.283 | 70,9 % |
| O1.5 | 76,3 % | 186 | 71,9 % |
| O0.5 | 78,3 % | 350 | 71,2 % |

## Übernommen

- `CONFIDENCE_MODELS` neu gelernt (Schwellen unverändert), Tor-Score-Bänder (-8..-6 63,2 %, -2..0 75,0 %, ≥ +1 81,3 %).
- Tool: `DEFAULT_CALIB` + Abzeichen „Kalibriert: 26.10.2026 · 14.432 Signale“.
- Keine Stufe an- oder abgeschaltet.

## Nächste Woche beobachten

- Over 1.5 Test: nur noch 1,5 Punkte über der Abschaltgrenze; ValueShots15 69,8 % (43) – bei ~100 Tipps entscheiden.
- O2.5: Filter nur +1 Punkt über roh – Marktvergleich in Admin „Ergebnisse“ abwarten (≥ 50 Tipps).
- O0.5 2 Einheiten: kaum Spiele mit Linie ≥ 4, solange „MoneyBag 0-0 → Goal“ aus ist.
