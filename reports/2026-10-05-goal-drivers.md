# Wann und warum fällt das Tor? – 05.10.2026

Datenbasis: alle vier Exporte (`data/inplayflux_sinyaller_*.csv`), dedupliziert
**10.491 entschiedene Signale** (05.09.–04.10.2026). Erzeugt mit
`scripts/goal_drivers.py`, das auch `calibration/goal_score.json` schreibt.

**Wichtig vorab:** Jede Strategie in den Exporten braucht genau **ein weiteres Tor**
(O2.5 bei 2 Toren, O3.5 bei 3 Toren, „Goal“ bei 0-0, O1.5 bei 1 Tor). Alle Signale
haben deshalb dasselbe Ergebnis: Fällt bis zum Abpfiff noch ein Tor? Das erlaubt eine
gemeinsame Auswertung über alle Strategien.

## 1. So funktioniert Radar X (RXG)

InPlayFlux beschreibt RXG nur als „Wahrscheinlichkeit für ein Tor“. Die Formel wird auf
dem Server berechnet. Aus den Exporten lässt sie sich aber fast vollständig nachbauen
(lineare Regression, **R² = 0,956**):

```
Radar X ≈ 54
        + 125   wenn Live-Over-Quote < Live-Under-Quote  (Markt erwartet ein Tor)
        + 0,94  × gefährliche Angriffe (beide Teams)
        + 0,53  × Angriffe
        + 6,2   × Ecken
        + 1,9   × Schüsse gesamt
        − 1,1   × Schüsse aufs Tor
        + 8,7   × Ø Tore in den letzten Spielen (beide Teams)
        − 4,2   × Ø Gegentore (beide Teams)
```

Gegen den Live-Feed geprüft: Bei laufenden Spielen in der 2. Halbzeit weicht die Formel
nur 0–5 Punkte vom Radar ab. Zwei Spiele zeigten den Markt-Bonus direkt. **Hapoel Kaukab**
sprang zwischen zwei Abrufen von 280 auf 414,5, **Always Ready** von 344 auf 476.
Beides passierte genau in dem Moment, in dem die Over-Quote unter die Under-Quote fiel.
In der Halbzeitpause bleibt der Radar stehen, die Quoten bewegen sich aber weiter.

**Folge:** Rund ein Drittel des Radar-Werts ist ein **Ja/Nein-Signal des Wettmarkts**. Der
Rest zählt vor allem **Angriffe und Ecken**, also Mengen und keine Qualität. Schüsse aufs
Tor gehen sogar leicht negativ ein. Deshalb trennt der Radar Tore kaum: Hoher Radar
(≥ 400) bringt +0,2 bis +0,6 pp, niedriger Radar (< 260) −1,2 pp.

## 2. Wann fällt das Tor?

| | |
|---|---|
| Torquote nach Signal gesamt | 72,9 % |
| Wartezeit bis zum Tor (Median) | **15 min** (Quartile 8–24 min) |
| Tor innerhalb 5 / 10 / 15 / 20 / 30 min | 10,5 % / 26,3 % / 37,6 % / 49,0 % / 65,8 % aller Signale |
| Anteil der Treffer in der Nachspielzeit (> 90') | **7,7 %** |

| Signal-Minute | n | Torquote | Tor-Wahrscheinlichkeit pro Restminute |
|---|---:|---:|---:|
| ≤ 57' | 4164 | 77,2 % | 2,03 % |
| 58–60' | 2434 | 73,3 % | 2,21 % |
| 61–63' | 2148 | 71,8 % | 2,28 % |
| 64–66' | 710 | 67,5 % | 2,41 % |
| 67–69' | 563 | 61,1 % | 2,44 % |
| 70–72' | 403 | 58,3 % | 2,62 % |

Spätere Signale sind nicht schlechter, weil das Spiel ruhiger wird. Die Tordichte pro
Minute **steigt** gegen Ende sogar. Sie verlieren, weil schlicht **weniger Zeit bleibt**.
Bei einem Signal in der 70. Minute kommt ein Großteil der verbleibenden Chance aus der
Nachspielzeit.

## 3. Warum fällt das Tor? Bedingungen im Zeitvergleich

Abweichung der Torquote vom jeweiligen Durchschnitt. Getrennt geprüft für den **alten**
Zeitraum (bis 26.09., n = 7.277) und den **neuen** (ab 27.09., n = 3.214). In der Tabelle
stehen nur Bedingungen, die in beiden Zeiträumen in dieselbe Richtung zeigen.

| Bedingung | Δ alt | Δ neu | Lesart |
|---|---:|---:|---|
| Vorab-Halbzeitlinie ≥ 1,5 | +5,7 | +4,9 | Buchmacher erwarten vor dem Spiel ein torreiches Spiel |
| Vorab-Torlinie ≥ 3,25 | +4,3 | +4,9 | dito |
| Signal ≤ 57' | +4,1 | +4,8 | mehr Restzeit |
| Score liegt > 1 Tor unter Vorab-Linie | +4,0 | +3,3 | das Spiel hat seine erwarteten Tore noch nicht „verbraucht“ |
| ≥ 9 Schüsse aufs Tor | +2,1 | +2,5 | echte Torgefahr (anders als Angriffe/Ecken) |
| Ø Gegentore ≥ 3 | +1,4 | +2,8 | schwache Abwehren |
| Letztes Tor ≤ 5 min her | −2,7 | −4,4 | Beruhigungsphase nach einem Tor |
| Over-Quote > 2,03 | −4,5 | −3,3 | Markt glaubt nicht an ein weiteres Tor |
| **Favorit führt mit 1 Tor** | −3,6 | −5,0 | Favorit verwaltet das Ergebnis |
| Ø Gegentore ≤ 2,2 | −3,9 | −4,8 | starke Abwehren |
| Vorab-Halbzeitlinie ≤ 1,0 | −3,4 | −6,6 | torarmes Spiel erwartet |
| Vorab-Torlinie ≤ 2,5 | −4,7 | −6,9 | dito |
| **Score ≥ Vorab-Linie** | −5,3 | −8,3 | die erwarteten Tore sind schon gefallen |
| **Signal ≥ 66'** | −10,3 | −12,9 | zu wenig Restzeit |

Die stabilsten Kombinationen (Torquote alt / neu):

- Vorab-Linie ≥ 3,25 **und** Signal ≤ 57': **83,8 % / 81,6 %**
- Vorab-Halbzeitlinie ≥ 1,5 **und** Signal ≤ 57': **85,0 % / 81,5 %**
- Signal ≤ 57' **und** ≥ 9 Schüsse aufs Tor: **80,3 % / 83,1 %**
- dagegen Vorab-Linie ≤ 2,5 **und** Signal ≥ 66': **50,0 % / 53,4 %**

**Kernaussage:** Ob noch ein Tor fällt, entscheiden vor allem drei Dinge. Erstens die
**Torerwartung vor dem Spiel** (Linien des Buchmachers). Zweitens die **Restzeit**.
Drittens, ob das Spiel diese **Erwartung schon erfüllt hat**. Das Live-Geschehen
(Angriffe, Radar) bringt im Vergleich wenig. Echte Torschüsse helfen etwas, und eine
knappe Führung des Favoriten bremst.

## 4. Der Tor-Score (Punktesystem)

Aus elf eindeutigen Bedingungen wurde ein Punktesystem gebaut (logistische Regression,
1 Punkt ≈ 0,1 Log-Odds). Für den Test wurde es **nur auf dem alten Zeitraum gelernt**.
Auf dem neuen Zeitraum erreicht es eine **AUC von 0,606**. Zum Vergleich: das bisherige
Worker-Modell (Minute, SoT, Radar, Vorab-Linie) kommt auf 0,583, ein Modell mit allen
30+ Werten auf 0,578. Mehr Werte bringen also nur mehr Rauschen.

| Bedingung | Punkte |
|---|---:|
| Signal 58–62' / 63–65' / ab 66' | −2 / −5 / −7 |
| Vorab-Torlinie ≤ 2,5 | −2 |
| Vorab-Torlinie ≥ 3,25 | +2 |
| Vorab-Halbzeitlinie ≥ 1,5 | +1 |
| Ø Gegentore beider Teams ≤ 2,2 | −2 |
| ≥ 9 Schüsse aufs Tor | +2 |
| Letztes Tor ≤ 5 min her | −1 |
| Over-Quote > 2,03 | −1 |
| Favorit führt mit genau 1 Tor | −1 |

| Tor-Score | n | Torquote alt | Torquote neu | Torquote gesamt | Mindestquote |
|---|---:|---:|---:|---:|---:|
| ≤ −9 | 514 | 56,4 % | 50,9 % | 54,7 % | 1,83 |
| −8 … −6 | 1310 | 65,3 % | 63,7 % | 64,0 % | 1,56 |
| −5 … −3 | 2934 | 69,7 % | 70,7 % | 70,3 % | 1,42 |
| −2 … 0 | 3582 | 76,2 % | 75,2 % | 75,3 % | 1,33 |
| ≥ +1 | 2151 | 81,6 % | 82,9 % | 82,1 % | 1,22 |

Die Bänder halten in beiden Zeiträumen, der Score ist also kein Zufallsprodukt.
Die Spalte „alt/neu“ zeigt die Validierung, die finalen Punkte sind auf allen Daten
gelernt.

## Änderungen

- `scripts/goal_drivers.py`: reproduzierbare Analyse, schreibt `calibration/goal_score.json`.
- `scripts/live_radar.py`:
  - zeigt pro Spiel den **Tor-Score** und die aktiven Bedingungen;
  - zerlegt **Radar X in Markt-Bonus und Spielanteil**;
  - vergibt **PREMIUM** nur noch ab Tor-Score ≥ −2;
  - der Tor-Score gilt erst ab der 50. Minute, weil er auf Signalen ab ca. 55' kalibriert ist.

## Grenzen

- Ein Tor bleibt zu einem großen Teil Zufall. Selbst das beste Band liegt bei rund 82 %,
  und eine AUC von 0,6 ist eine nützliche, aber moderate Trennung.
- Alle Daten stammen aus Situationen, in denen schon ein Strategie-Signal gefeuert hat.
  Für beliebige Spiele (z. B. 1. Halbzeit) gilt der Score nicht.
- Kickoff-Quoten (`p_odds`) bestimmen den Favoriten. Fehlen sie im Feed, entfällt die
  Bedingung „Favorit führt mit 1“.
