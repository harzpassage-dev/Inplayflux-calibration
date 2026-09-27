# Kalibrierungs-Report – 27.09.2026

Datenbasis: `data/inplayflux_sinyaller_2026-09-20.csv` + `data/inplayflux_sinyaller_2026-09-27.csv`,
kombiniert 10.000 Signale, erzeugt mit `scripts/analyze_signals.py` (unterstützt jetzt mehrere Dateien).

Dieser Report erweitert den vom 20.09. um alle Nebenstrategien, die vorher nur mit einer
Woche Daten zu klein für eine belastbare Kalibrierung waren, und bestätigt die
Haupterkenntnisse mit doppelter Stichprobe.

## Hauptstrategien – bestätigt mit doppelter Stichprobe

| Strategie | n (kombiniert) | Win Rate | Mindestquote | Ø Quote | Puffer |
|---|---:|---:|---:|---:|---:|
| `MoneyBag 2-0/0-2 → Over 2.5` | 4501 | 75,7 % | 1,32x | 1,91 | +0,59 |
| `MoneyBag + 3 Goals → Over 3.5` | 3591 | 69,5 % | 1,44x | 1,90 | +0,46 |

Der Zeitverfall-Befund vom 20.09. hält mit doppelter Stichprobe:

- `Over 2.5`: 55-67' stabil (65–81 %), danach klarer Einbruch bei 68–70' (65 %, 41 %, 51 %).
  → Empfehlung unverändert: `dakika <= 67`.
- `Over 3.5`: 60-63' stabil (67–75 %), Einbruch bei 64–65' (~60 %), kurze Erholung bei 66–67',
  danach erneuter Abfall. → Empfehlung unverändert: `dakika <= 63` (konservativ, da die
  Erholung bei 66/67' auf kleiner Stichprobe beruht).

## Neu: `Over 2.5 Odd Filter`

Am 27.09. neu aufgetaucht — dieselbe Basis-Regel wie `Over 2.5`, plus zusätzlicher Filter
`ouOverOdds >= 1.7`. Performance (74,4 % WR, n=696) und Zeitverfall-Muster sind statistisch
nicht von der Basisstrategie zu unterscheiden. **Empfehlung:** gleiche Zeitfenster-Verschärfung
wie bei `Over 2.5` anwenden (`dakika <= 67`). Nur eine Woche Daten — nach dem nächsten Export
erneut prüfen.

## Nebenstrategien – jetzt erstmals kalibriert (kombinierte Daten)

| Strategie | n | Win Rate | Mindestquote | Puffer | Befund |
|---|---:|---:|---:|---:|---|
| `Over 0.5 Value` | 416 | 71,9 % | 1,39x | +0,52 | Signale feuern fast nur bei Minute 61 (72,5 %) / 62 (67,2 %), obwohl Regel bis Minute 79 erlaubt. Zu wenig späte Daten für ein Urteil. |
| `MoneyBag 0-0 → Goal` | 199 | 73,4 % | 1,36x | +0,55 | Gleiches Muster: nur Minute 61 (77,2 %) / 62 (66,7 %) mit Daten, Regel erlaubt bis 71'. |
| `Over 1.5` | 179 | 72,6 % | 1,38x | +0,53 | Stark bei 60–61' (78–85 %), danach kaum Signale trotz Regelfenster bis 75'. |
| `Over 1.5 cloude` | 171 | 72,5 % | 1,38x | +0,47 | Gleiches Bild wie `Over 1.5`. |
| `Over 1.5 claude 1.änderung` | 193 | 74,6 % | 1,34x | +0,49 | Leicht beste der drei Over-1.5-Varianten, Unterschied aber noch im Rauschen. |
| `HT over 0.5` | 44 | 56,8 % | 1,76x | +0,18 | **Bestätigt schwach** in beiden Wochen (57,5 % → 56,8 %). Kleinster Puffer aller Strategien. |

**Auffälligkeit bei allen fünf `Over 0.5/1.5`-Varianten:** Die Regeln erlauben Signal-Minuten
weit über das hinaus, was in der Praxis tatsächlich vorkommt (z. B. bis Minute 75 oder 79),
aber so gut wie alle Signale feuern innerhalb der ersten 1–3 Minuten des erlaubten Fensters.
Das deutet darauf hin, dass die übrigen Filter (`toplamSutTotal`, `son5iki`, `rx`) das
Zeitfenster faktisch schon stark einschränken — die weiten `dakika`-Grenzen in diesen Regeln
sind wahrscheinlich unschädlich, aber auch ungetestet für späte Minuten. Keine Änderung
empfohlen, bis mehr späte Signale vorliegen.

## `HT over 0.5`: zwei Wochen in Folge schwach

57,5 % (20.09., n=40) und 56,8 % (27.09., n=44) — zwei unabhängige Stichproben bestätigen sich
gegenseitig. Das ist ein stärkeres Signal als eine einzelne schwache Woche. **Empfehlung:**
diese Regel grundlegend überarbeiten (andere `rx`/`toplamSut`-Schwellen) statt nur mehr Daten
abzuwarten.

## Radar X Score & Market Drop %

Radar X Score bestätigt den 20.09.-Befund (kein starker Zusammenhang, 71–75 % über alle
Buckets). Market Drop % ist diese Woche uneindeutig/leicht fallend statt wie am 20.09.
ansteigend bei ≥30 % — bei den kleinen Stichproben (n=83–166 je Bucket) noch nicht belastbar.

## Nächste Schritte

1. `dakika <= 67` (Over 2.5 / Over 2.5 Odd Filter) und `dakika <= 63` (Over 3.5) in die
   Live-Regeln übernehmen — jetzt mit doppelter Stichprobe bestätigt.
2. `HT over 0.5` überarbeiten statt nur beobachten — zwei Wochen in Folge schwach.
3. Bei den `Over 0.5`/`Over 1.5`-Varianten: nichts ändern, aber beobachten, ob mit mehr
   Datenvolumen auch späte Minuten (>62/63) auftauchen, um das reale Zeitfenster zu prüfen.
4. `tools/moneybag-analyst.html`-Kalibrierung (`DEFAULT_CALIB`) ist noch auf dem Stand vom
   20.09. — ein Re-Sync auf die kombinierten 2-Wochen-Daten steht aus.
