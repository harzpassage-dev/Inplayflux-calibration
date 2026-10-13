# Fachartikel – zum Einreichen / Veröffentlichen

Zwei Fassungen: **A** (lang) für Wettbasis, Medium, Substack, LinkedIn oder einen Blog;
**B** (kurz) für Foren und Reddit – dort ohne Link, nur die offene Betreiber-Angabe.
Alle Zahlen stammen aus den eigenen Auswertungen (Stand 13.10.2026) und sind so belegbar.

---

## A) Lange Fassung

# Was 11.610 Live-Signale über das nächste Tor verraten

*Ein Erfahrungsbericht aus der Datenauswertung – und warum eine hohe Trefferquote allein
noch keinen Gewinn macht.*

Live-Wetten auf „noch ein Tor“ gehören zu den beliebtesten Märkten im Fußball. Signal-Dienste
versprechen dafür oft Trefferquoten von 80 oder 90 Prozent. Ich habe mir die Frage gestellt,
was davon in echten Daten übrig bleibt, und über einen Monat hinweg **11.610 abgeschlossene
Live-Signale** ausgewertet (5. September bis 10. Oktober 2026). Jedes dieser Signale setzt auf
dasselbe Ereignis: **Fällt bis zum Abpfiff noch genau ein weiteres Tor?** – ob als Over 0.5
bei 0:0, Over 2.5 bei zwei Toren oder Over 3.5 bei drei.

### 1. Die Grundquote: knapp drei von vier

Über alle Signale hinweg fiel in **rund 73 Prozent** der Fälle noch ein Tor. Das klingt viel –
ist aber genau der Wert, den auch der Wettmarkt kennt. Wer blind jedes Signal spielt, landet
deshalb bei Quoten, die diese 73 Prozent bereits einpreisen. Ein Vorteil entsteht erst, wenn
man die Spiele findet, in denen die Wahrscheinlichkeit deutlich höher liegt als im Schnitt.

### 2. Wann das Tor fällt

- Im **Median** fällt das nächste Tor **15 Minuten** nach dem Signal (die Hälfte aller Tore
  zwischen 8 und 24 Minuten).
- Nur jedes zehnte Tor kommt in den ersten fünf Minuten.
- **7,7 Prozent** aller Treffer fallen erst in der Nachspielzeit.

Überraschend war der Blick auf die Signal-Minute: Je später das Signal, desto schlechter die
Quote – aber **nicht**, weil die Spiele ruhiger würden. Die Tordichte pro Restminute *steigt*
gegen Ende sogar leicht (von etwa 2,0 auf 2,6 Prozent pro Minute). Späte Signale verlieren,
weil schlicht weniger Zeit bleibt:

| Signal-Minute | Tor fiel noch |
|---|---:|
| bis 57' | 77 % |
| 61–63' | 72 % |
| 67–69' | 61 % |
| 70–72' | 58 % |

### 3. Was ein Tor wirklich ankündigt – und was nicht

Viele Live-Scanner zeigen einen „Druck-“ oder „Radar“-Wert. Ich konnte den untersuchten
Radar-Wert fast vollständig aus den Live-Statistiken nachbauen (Bestimmtheitsmaß 0,96). Das
Ergebnis war ernüchternd: **Rund ein Drittel des Werts ist schlicht die Frage, ob der
Wettmarkt Over favorisiert**; der Rest zählt vor allem Angriffe und Ecken – Menge, nicht
Qualität. Ein hoher Radar brachte im Schnitt kaum einen halben Prozentpunkt.

Deutlich mehr sagen drei andere Dinge – und zwar in zwei getrennten Zeiträumen gleich:

1. **Die Torerwartung vor dem Spiel.** Lag die Vorab-Torlinie der Buchmacher bei 3,25 oder
   höher, fiel um rund 5 Prozentpunkte häufiger noch ein Tor; bei 2,5 oder darunter um 5 bis 7
   Punkte seltener.
2. **Die Restzeit.** Signale ab der 66. Minute lagen 10 bis 13 Punkte unter dem Schnitt.
3. **Ob das Spiel seine Erwartung schon erfüllt hat.** Steht es bereits so, wie die Vorab-Linie
   erwarten ließ, kommt seltener noch etwas nach (−5 bis −8 Punkte).

Kleinere, aber stabile Effekte: echte Schüsse aufs Tor helfen (+2 bis +3 Punkte), ein gerade
gefallenes Tor bremst kurz (−3), und **ein Favorit, der knapp mit einem Tor führt, verwaltet
eher** (−4 bis −5).

Aus elf solchen Bedingungen habe ich ein einfaches Punktesystem gebaut. Es trennt sauber: In
der schwächsten Gruppe fiel nur in **54 Prozent** der Fälle noch ein Tor, in der stärksten in
**81 Prozent** – und zwar in beiden Prüfzeiträumen nahezu gleich.

### 4. Die Mindestquote: warum 80 Prozent Verlust bedeuten können

Der wichtigste Satz dieses Artikels: **Eine Trefferquote ist ohne Quote wertlos.** Wer zu
80 Prozent trifft, braucht mindestens eine Quote von **1,25**, um auf Dauer nicht zu verlieren
(1 geteilt durch 0,80). Bei 70 Prozent sind es schon 1,43. Liegt die angebotene Quote darunter,
verliert man trotz hoher Trefferquote – nur langsamer.

Deshalb nenne ich zu jedem Signal die **Mindestquote** und spiele es nur, wenn die Live-Quote
darüber liegt. Das klingt banal, ist aber der Punkt, an dem die meisten Tipp-Angebote schweigen.

### 5. Live gegenprüfen – und was das gebracht hat (und was nicht)

Ein Signal wird bei mir nicht sofort verschickt, sondern **zwei Minuten später live geprüft**:
Ist inzwischen ein Tor gefallen? Gab es eine Rote Karte? Passt die Wahrscheinlichkeit noch?

Ehrlicherweise: Die erste Version dieser Prüfung war zu streng. Sie hat die Zahl der Signale
halbiert, **ohne** die Trefferquote zu verbessern – weil allein die zwei Minuten Wartezeit die
berechnete Wahrscheinlichkeit drücken. Erst mit einer Toleranz von fünf Prozentpunkten blieb
die Qualität gleich und die Menge fast doppelt so hoch.

### 6. Was in der Praxis hält – und was nicht

Die strengste Stufe („High Confidence“) lag in der Rückrechnung bei rund 80 Prozent. Live sah
es so aus:

- In der Woche bis 13. Oktober traf sie **91 von 112 Mal (81,3 Prozent)**.
- Auf den Tagen davor, die das Modell noch nie gesehen hatte (6.–10. Oktober), waren es
  **76 Prozent** (245 Signale) – also spürbar weniger als erwartet.

Eine zweite Stufe für späte Signale ab der 70. Minute kam in der Rückrechnung auf 63 bis
65 Prozent. Live traf sie nur **8 von 20** und danach **4 von 9** Mal. Ich habe sie
abgeschaltet. Auch das gehört zu einem ehrlichen System: Was live nicht hält, fliegt raus.

### 7. Drei Lehren

1. **Vorab-Erwartung und Restzeit schlagen jeden Live-Druckwert.** Wer Over-Wetten live spielt,
   sollte zuerst auf die Vorab-Torlinie und die Uhr schauen.
2. **Trefferquote nie ohne Mindestquote nennen** – und nie ohne Stichprobengröße.
3. **Rückrechnung ist nicht Realität.** Jede Regel muss sich auf Tagen beweisen, die sie nicht
   kennt. Alles andere ist Kurvenanpassung.

---

*Offenlegung: Der Autor betreibt den Signal-Kanal MoneyBag (Telegram: @MoneyBagAnalyst), dessen
System auf dieser Auswertung beruht. Alle Ergebnisse werden dort automatisch erfasst und
wöchentlich mit Treffern und Verlusten veröffentlicht. Sportwetten bergen Verlustrisiken,
18+, keine Gewinngarantie. Hilfe bei Spielsucht: check-dein-spiel.de*

---

## B) Kurze Fassung (Foren / Reddit, ohne Link)

**Titel:** 11.610 Live-Signale auf „noch ein Tor“ ausgewertet – was wirklich zählt

Ich habe einen Monat lang 11.610 abgeschlossene Live-Signale ausgewertet, die alle auf
„noch genau ein Tor bis Abpfiff“ setzen. Ein paar Ergebnisse, die mich überrascht haben:

- **Grundquote ~73 %** – genau das, was der Markt ohnehin einpreist.
- **Median bis zum Tor: 15 Minuten**, 7,7 % der Tore erst in der Nachspielzeit.
- **Späte Signale verlieren nicht, weil das Spiel einschläft** – die Tordichte pro Minute
  steigt sogar –, sondern weil die Zeit fehlt (bis 57': 77 %, ab 70': 58 %).
- **Live-„Druck/Radar“-Werte bringen kaum etwas**; ein Drittel davon ist nur die Marktmeinung.
  Viel stärker: die **Vorab-Torlinie** (≥ 3,25 → +5 Punkte) und ob das Spiel seine Erwartung
  **schon erfüllt** hat (−5 bis −8).
- **Favorit führt knapp mit 1 Tor → seltener noch ein Tor** (−4 bis −5 Punkte).
- Eine Rückrechnung mit 65 % für späte Signale hat live nur 12 von 29 getroffen – Backtests
  immer auf ungesehenen Tagen prüfen.

Und das Wichtigste: Bei 80 % Trefferquote braucht man mindestens Quote **1,25**, bei 70 %
schon **1,43** – sonst verliert man trotz hoher Quote.

*Offenlegung: Ich betreibe einen Signal-Kanal auf Basis dieser Auswertung. 18+, keine
Gewinngarantie.*
