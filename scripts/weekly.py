#!/usr/bin/env python3
"""Wochen-Routine in einem Schritt (Punkt 6 des Plans vom 22.10.).

Nimmt den rohen InPlayFlux-Export, prüft die Zeitverschiebung gegen den letzten Export, normalisiert ihn
nach data/, und lässt alle Auswertungen laufen (Modelle mit Zeit-Test auf den neuen Tagen, Tor-Score,
Over 0.5 / 1.5 / 2.5 / 3.5). Schreibt alles nach reports/<datum>-wochen-check.txt und zeigt die
Zeit-Test-Zeilen. Übernimmt NICHTS in den Worker: das macht Claude danach nach
.claude/skills/wochen-routine/SKILL.md.

  python3 scripts/weekly.py RAW.csv
"""
import glob, os, re, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
if len(sys.argv) != 2:
    sys.exit(__doc__)
raw = sys.argv[1]
run = lambda *cmd: subprocess.run([sys.executable, *cmd], capture_output=True, text=True)

prev = sorted(glob.glob("data/inplayflux_sinyaller_*.csv"))[-1]
chk = run("scripts/normalize_export.py", raw, "--check-against", prev)
print(chk.stdout.strip() or chk.stderr.strip())
m = re.search(r"\[\((-?\d+), \d+\)", chk.stdout)
if chk.returncode or not m or m.group(1) != "0":
    sys.exit("STOP: Zeitverschiebung gegen den letzten Export ist nicht 0 – --shift-min prüfen, nichts geschrieben.")
w = run("scripts/normalize_export.py", raw, "--write")
print(w.stdout.strip())
new = sorted(glob.glob("data/inplayflux_sinyaller_*.csv"))[-1]
# Split = last signal time of the previous export: everything after it is unseen by the old models.
last = max(re.findall(r"\d{4}-\d\d-\d\d \d\d:\d\d:\d\d", open(prev, encoding="utf-8-sig").read()))
files = sorted(glob.glob("data/*.csv"))
out = [f"Wochen-Check {os.path.basename(new)} · neue Tage ab {last}\n"]
for title, cmd in [
    ("Modelle (CV + Zeit-Test)", ["scripts/recalibrate.py", *files, "--split", last]),
    ("Tor-Score", ["scripts/goal_drivers.py", *files]),
    ("Over 0.5", ["scripts/o05_stats.py", *files]),
    ("Over 2.5", ["scripts/o25_stats.py", *files]),
    ("Over 3.5 / Halbzeit / Over 1.5", ["scripts/o35_scoreline.py", *files]),
]:
    r = run(*cmd)
    out.append(f"\n===== {title} =====\n{r.stdout}{r.stderr[-2000:] if r.returncode else ''}")
# goal_drivers writes calibration/goal_score.json; keep it only when Claude applies the week.
subprocess.run(["git", "checkout", "--", "calibration/goal_score.json"], capture_output=True)
date = re.search(r"(\d{4}-\d\d-\d\d)", new).group(1)
path = f"reports/{date}-wochen-check.txt"
open(path, "w", encoding="utf-8").write("".join(out))
print(f"\n{path} geschrieben. Zeit-Test (Modell gelernt bis {last[:10]}, geprüft danach):")
for line in "".join(out).splitlines():
    if "Zeit-Test" in line or line.startswith("=== O"):
        print(" ", line.strip())
