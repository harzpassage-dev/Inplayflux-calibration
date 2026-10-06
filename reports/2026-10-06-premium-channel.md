# Premium-Kanal – Auswertung 06.10.2026

Datenbasis: `data/inplayflux_sinyaller_2026-10-06.csv` (4.481 Signale, 21.09.–06.10.).

Zur Datei:
- Der Export kam in einem neuen Format: Datum als `06/10/2026, 16:54:03` und **eine Stunde
  früher** (andere Zeitzone) als die bisherigen Exporte.
- Er wurde ins bisherige Format umgewandelt (`="2026-10-06 17:54:03"`, +1 h). Danach
  stimmen 4.164 Zeilen mit den alten Exporten überein, die Ergebnisse zu 99,5 %.
- **316 entschiedene Signale sind neu** (04.10. ab 20:20 bis 06.10.). Auf ihnen wurde das
  Modell nie trainiert, sie sind der ehrliche Test.

Ein Premium-Log aus dem Worker lag nicht vor. Der Kanal wurde deshalb **nachsimuliert**.
Das geht, weil der Worker ein festes Modell auf die Werte zum Signalzeitpunkt anwendet:
Minute, Schüsse aufs Tor, Radar und Vorab-Linie. Die simulierte Trefferquote für
02.–04.10. (80,7 %) passt zur damals gemessenen echten Quote (79,5 %, n = 307).

## 1. High Confidence (alte Logik: sofort posten)

| Zeitraum | n | Treffer | Mindestquote |
|---|---:|---:|---:|
| 21.09.–01.10. | 494 | 79,4 % | 1,26 |
| 02.–04.10. | 429 | 80,7 % | 1,24 |
| **neu, 04.10. abends–06.10.** | **89** | **80,9 %** | **1,24** |

Das Modell hält auf neuen Daten, was es verspricht: rund **80 %**, gegenüber 70–72 % für
alle Signale.

## 2. Die neue 2-Minuten-Prüfung

| | alle Zeiträume | neu |
|---|---|---|
| alt: sofort gepostet | n = 1012, 80,0 % | n = 89, 80,9 % |
| **neu: nach Prüfung gepostet** | **n = 483, 81,4 %** | **n = 43, 79,1 %** |
| neu: verworfen | n = 529, 78,7 % | n = 46, 82,6 % |

**Die Prüfung halbiert die Zahl der Posts, ohne die Trefferquote zu verbessern.** Die
verworfenen Signale waren genauso gut, zwischen 02. und 06.10. sogar besser.

Ursache: Gut 80 % der Ablehnungen kommen von „Modell < Schwelle“. Das Modell bestraft jede
Minute (Koeffizient −0,28 je Standardabweichung). Allein die 2 Minuten Wartezeit senken
die Wahrscheinlichkeit im Median um 2 Prozentpunkte. Viele Signale knapp über der Schwelle
fallen dadurch rein rechnerisch durch, ohne dass sich im Spiel etwas verschlechtert hat.

Die übrigen Gründe:
- **Tor in den 2 Minuten:** 10 Fälle, alle gewonnen. Das ist der Preis der Wartezeit, aber
  er ist klein (1 %).
- **Rote Karte:** 50 Fälle, 80 %, also kein Nachteil erkennbar.
- **Tor-Score < −2:** 35 Fälle, gemischt (55–100 % je Zeitraum, kleine Zahlen).

### Varianten im Vergleich

| Prüfung nach 2 min | Posts (alle) | Treffer | Posts (neu) | Treffer (neu) |
|---|---:|---:|---:|---:|
| keine (alte Logik) | 1012 | 80,0 % | 89 | 80,9 % |
| **aktuell** (Modell bei Minute + 2, Tor-Score) | 483 | 81,4 % | 43 | 79,1 % |
| nur harte Checks (Tor, Rote Karte, 70') | 950 | 80,0 % | 87 | 80,5 % |
| **harte Checks + Tor-Score ≥ −2** | **862** | **81,0 %** | **79** | **81,0 %** |
| harte Checks + Tor-Score + Modell mit 5 pp Toleranz | 862 | 81,0 % | 79 | 81,0 % |

**Empfehlung:** Die Modellschwelle bei der Live-Prüfung um 5 Prozentpunkte lockern und den
Tor-Score behalten. Gleiche Trefferquote wie jetzt (81 %), aber **fast doppelt so viele
Posts**. Die Toleranz fängt den reinen Minuten-Effekt ab. Eine echte Verschlechterung im
Spiel, etwa wenn der Radar fällt, schlägt trotzdem durch.

## 3. Risiko-Signale (ab 70', unter der Schwelle)

| Zeitraum | n | Treffer | Mindestquote |
|---|---:|---:|---:|
| 21.09.–01.10. | 100 | 54,0 % | 1,85 |
| 02.–04.10. | 84 | 58,3 % | 1,71 |
| neu | 11 | 81,8 % | 1,22 (zu wenig Daten) |

Nur sinnvoll, wenn die Live-Quote auf die Ziel-Linie über etwa **1,75** liegt.

## 4. Nach Ziel-Linie (alte Logik, alle Zeiträume)

| Linie | n | Treffer | Mindestquote |
|---|---:|---:|---:|
| O0.5 | 85 | 76,5 % | 1,31 |
| O1.5 | 41 | 80,5 % | 1,24 |
| O2.5 | 509 | 82,5 % | 1,21 |
| O3.5 | 377 | 77,5 % | 1,29 |

## Wichtiger Hinweis zu Quoten / ROI

Die Spalte „O/U Üst Oranı“ im Export liegt im Schnitt bei 1,89. Das ist die Quote der
**Haupt-Live-Linie**, nicht der Ziel-Linie des Signals. Over 2.5 bei 2:0 in der
55. Minute steht in Wirklichkeit deutlich tiefer. Ein daraus berechneter ROI wäre stark
geschönt und wird hier bewusst nicht angegeben. Maßgeblich ist die **Mindestquote**: Ein
Premium-Signal ist nur profitabel, wenn die Over-Quote auf die Ziel-Linie mindestens etwa
**1,24** beträgt.

## Umgesetzt (06.10.)

- **2-Minuten-Prüfung:** Die Modellschwelle bei der Live-Prüfung hat jetzt 5 pp Toleranz
  (`CONFIRM_TOLERANCE` im Worker).
- **Risiko-Stufe:** Nur noch Karten ab Minute 72 oder mit Radar ≥ 410 werden gepostet.
  - Rückrechnung über 480 Risiko-Signale: behalten 244 mit 64,8 %, wegfallend 236 mit 55,9 %.
  - In beiden Hälften des Zeitraums geprüft: 68,2 % / 60,7 % gegenüber 56,3 % / 55,6 %.
  - Mindestquote der verbleibenden Risiko-Signale: etwa 1,55.
