#!/usr/bin/env python3
"""
fetch_odds.py — Live-/Vorspiel-Quoten von The Odds API (v4)

Nutzung:
  export ODDS_API_KEY="dein_key"
  python fetch_odds.py --sports                      # Fußball-Ligen auflisten (kostet 0 Credits)
  python fetch_odds.py soccer_chile_campeonato "Colo"  # Spiele filtern (Teilname), 1X2 + Über/Unter
  python fetch_odds.py soccer_chile_campeonato "Colo" --markets totals   # nur Über/Unter (1 Credit)

Credit-Kosten pro Abruf = Anzahl Märkte x Anzahl Regionen.
Der API-Key gehört NICHT in den Code (Umgebungsvariable / GitHub Secret).
"""
import argparse
import os
import sys

import requests

BASE = "https://api.the-odds-api.com/v4"


def key():
    k = os.environ.get("ODDS_API_KEY")
    if not k:
        sys.exit("ODDS_API_KEY nicht gesetzt.")
    return k


def list_sports():
    r = requests.get(f"{BASE}/sports", params={"apiKey": key(), "all": "true"}, timeout=15)
    r.raise_for_status()
    for s in r.json():
        if s["key"].startswith("soccer"):
            print(f'{s["key"]:45} {s["title"]}  (aktiv: {s["active"]})')


def fetch(sport, markets, regions):
    r = requests.get(
        f"{BASE}/sports/{sport}/odds",
        params={
            "apiKey": key(),
            "regions": regions,
            "markets": markets,
            "oddsFormat": "decimal",
        },
        timeout=15,
    )
    r.raise_for_status()
    print(f'[Credits übrig: {r.headers.get("x-requests-remaining")} | '
          f'diesen Abruf: {r.headers.get("x-requests-last")}]')
    return r.json()


def best_h2h(game):
    best = {}
    for bm in game["bookmakers"]:
        for m in bm["markets"]:
            if m["key"] != "h2h":
                continue
            for o in m["outcomes"]:
                if o["name"] not in best or o["price"] > best[o["name"]][0]:
                    best[o["name"]] = (o["price"], bm["title"])
    return best


def best_totals(game):
    best = {}  # (line, "Over"/"Under") -> (price, bookmaker)
    for bm in game["bookmakers"]:
        for m in bm["markets"]:
            if m["key"] != "totals":
                continue
            for o in m["outcomes"]:
                k = (o["point"], o["name"])
                if k not in best or o["price"] > best[k][0]:
                    best[k] = (o["price"], bm["title"])
    return best


def show(game):
    print(f'\n{game["home_team"]} vs {game["away_team"]}  ({game["commence_time"]})')
    h = best_h2h(game)
    for name, (p, bm) in h.items():
        print(f"  1X2  {name:25} {p:5.2f}  ({bm})")
    t = best_totals(game)
    for (line, side), (p, bm) in sorted(t.items()):
        print(f"  O/U  {side} {line:<5} {p:5.2f}  ({bm})")
    if not h and not t:
        print("  keine Quoten verfügbar")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("sport", nargs="?")
    ap.add_argument("team", nargs="?", default="")
    ap.add_argument("--sports", action="store_true")
    ap.add_argument("--markets", default="h2h,totals")
    ap.add_argument("--regions", default="eu")
    a = ap.parse_args()

    if a.sports:
        return list_sports()
    if not a.sport:
        ap.error("Liga-Key fehlt (siehe --sports)")

    games = fetch(a.sport, a.markets, a.regions)
    q = a.team.lower()
    hits = [g for g in games if q in g["home_team"].lower() or q in g["away_team"].lower()]
    if not hits:
        print("Kein passendes Spiel gefunden (evtl. nicht live/gelistet).")
    for g in hits:
        show(g)


if __name__ == "__main__":
    main()
