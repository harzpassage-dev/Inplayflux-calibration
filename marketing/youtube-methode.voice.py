# (start, end, speaker, text) – speaker: 0 amused, 6 surprised, 4 neutral
SEGS=[
(0.3,6,6,"Leute! Kann man einer Fußball-Statistik eigentlich trauen?!"),
(6,14,0,"Bleib dran! Wir zeigen dir unsere Methode – und alles, was wir damit über Tore rausgefunden haben!"),
(14.3,22,0,"Unsere Basis: über dreizehntausend Live-Spielszenen! Aus Hunderten Ligen – vom Dorfplatz bis zum Profi-Stadion!"),
(22,31,0,"Bei jeder Szene schreiben wir mit: Minute, Spielstand, Schüsse aufs Tor, Ecken und die Tor-Erwartung vor dem Anpfiff."),
(31,40,6,"Und dann heißt es: Warten bis zum Abpfiff. Fällt da noch ein Tor? Ja oder nein?!"),
(40.3,50,0,"Ganz wichtig: Manche Spiele tauchen doppelt auf. Bei uns zählt jedes Spiel nur ein einziges Mal!"),
(50,66,0,"Szenen aus der ersten Halbzeit kommen in einen eigenen Topf. Übrig bleiben achttausendsechshundertachtzig Spiele mit einer Szene rund um Minute sechzig. Sauber gezählt!"),
(66.3,76,6,"Und jetzt kommt der Härtetest! Wir schneiden den Zeitraum genau in zwei Hälften."),
(76,88,0,"Nur was in beiden Hälften gleich aussieht, schafft es ins Video! Klare Führung: siebenundsiebzig – und nochmal siebenundsiebzig Prozent. Bestanden!"),
(88,102,6,"Spanien? Achtundsechzig gegen vierundsiebzig. Viel zu wackelig – raus damit! Und zu kleine Gruppen fliegen sowieso."),
(102.3,112,6,"Und jetzt der Knaller: In drei von vier Szenen nach Minute sechzig fällt noch ein Tor!"),
(112,122,0,"Dreiundsiebzig Prozent! Und das in beiden Hälften – das ist kein Zufall!"),
(122.3,133,6,"Tore fallen spät, Leute! Jedes fünfte nächste Tor kommt erst nach Minute fünfundachtzig – sieben Prozent sogar in der Nachspielzeit!"),
(133,144,0,"Ab Minute sechsundsiebzig steigt die Torchance pro Minute um fast ein Drittel. Also: Nie zu früh abschalten!"),
(144.3,154,0,"Null zu null nach sechzig Minuten? Langweilig? Von wegen! In siebzig Prozent fällt noch ein Tor!"),
(154,164,6,"Und wenn vorher viele Tore erwartet wurden: zweiundachtzig Prozent! Bei wenigen nur vierundsechzig."),
(164.3,174,0,"Auch der Spielstand spielt mit: Bei null zu null siebzig Prozent, bei Gleichstand mit Toren fünfundsiebzig."),
(174,184,6,"Und eine klare Führung? Die macht das Spiel nicht kaputt: siebenundsiebzig Prozent!"),
(184.3,192,0,"Ab auf Weltreise! Finnland: einundachtzig Prozent! Polen: neunundsiebzig!"),
(192,200,6,"Und Brasilien, das Fußball-Land? Nur achtundsechzig! Der Schnitt liegt bei dreiundsiebzig."),
(200.3,209,0,"Mythen-Check! Viele Ecken bringen kaum mehr Tore. Und Frauen schießen genauso viele Tore wie Männer!"),
(209,218,6,"Und die Null muss stehen? Nur dreißig Prozent der Null-zu-null-Spiele bleiben auch null zu null!"),
(218.3,226,4,"Aber ganz ehrlich: Dreiundsiebzig Prozent heißt auch, in siebenundzwanzig Prozent fällt kein Tor mehr."),
(226,232,4,"Und wer trifft, wissen wir nicht. Statistik erklärt viele Spiele – nicht das nächste."),
(232.3,240,6,"Welche Frage sollen wir als Nächstes prüfen? Ab in die Kommentare – und abonniere Torminute!"),
]

# Voice: Piper de_DE-thorsten_emotional-medium (speakers 0 amused / 6 surprised / 4 neutral), --length-scale 0.9,
# --noise-scale 0.8 --noise-w-scale 1.0 (livelier). Background: youtube-methode.bg.py (self-made crowd + cheers + 120 BPM
# groove, royalty-free), volume 0.42, ducked under the voice (sidechaincompress), loudnorm -15 LUFS.
