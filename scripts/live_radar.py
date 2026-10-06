#!/usr/bin/env python3
"""Live radar: pull the InPlayFlux live-scanner feed, check every running
match against our strategy rules and score each hit with the same
logistic-regression confidence models the worker uses for the premium
channel (calibration/rules.json -> live_confidence_models).

The scanner page (inplayflux.com/live-scanner) loads its table from
maclarv8/GETAllMatches.php as plain JSON; the raw match data needs no
login. Field mapping (feed key -> rule / export column):

    minute       -> dakika / Signal Min
    hg, ag       -> toplamGol (goals at signal)
    so[0]+so[1]  -> total shots on target
    ar[0]+ar[1]  -> toplamSutTotal (total shots)
    xg           -> Radar X Score  (the "RXG" column's big number)
    p_goal       -> pre-match goal line (MÖ Gol Baremi)
    p_goal_h     -> pre-match first-half goal line (MÖ İY Gol Baremi)
    p_avg_g_g    -> avg goals in the teams' last matches (Ort Gol Atar)
    p_avg_g_c    -> avg goals conceded (Ort Gol Yer)
    sonGolDakikasi -> minute of the last goal
    p_odds       -> kickoff 1X2 odds (who the favourite is)
    ou_odds      -> [live over odds, live under odds, live goal line]
    vu           -> paraCuvali (MoneyBag flag)
    value        -> value

Usage:
    python3 scripts/live_radar.py                       # one snapshot
    python3 scripts/live_radar.py --all                 # also list matches without a hit
    python3 scripts/live_radar.py --watch 60 --log data/live_radar_log.csv
    python3 scripts/live_radar.py --file snapshot.json  # offline, from a saved feed
"""
import argparse
import csv
import json
import math
import os
import sys
import time
import urllib.request
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RULES_PATH = os.path.join(ROOT, "calibration", "rules.json")
GOAL_SCORE_PATH = os.path.join(ROOT, "calibration", "goal_score.json")
FEED_URL = "https://inplayflux.com/maclarv8/GETAllMatches.php?inplay=inplay&v={ts}"
MIN_POLL_SECONDS = 30  # be polite to the site; the page itself refreshes about this often

# Strategy rules as configured on InPlayFlux (current_rule in rules.json),
# plus the tighter recommended upper minute where calibration suggests one.
# Rule fields we can't see in the feed (son5iki, ustAdayi) are noted in "partial".
STRATEGIES = [
    {"name": "MoneyBag 2-0/0-2 -> Over 2.5", "line": 2.5, "goals": 2,
     "min": 55, "max": 73, "rec_max": 67, "need_vu": True},
    {"name": "MoneyBag + 3 Goals -> Over 3.5", "line": 3.5, "goals": 3,
     "min": 60, "max": 71, "rec_max": 63, "need_vu": True},
    {"name": "MoneyBag 0-0 -> Goal", "line": 0.5, "goals": 0,
     "min": 61, "max": 71, "rec_max": None, "need_vu": True},
    {"name": "Over 0.5 Value", "line": 0.5, "goals": 0,
     "min": 61, "max": 79, "rec_max": None, "need_vu": False, "need_value": True},
    {"name": "Over 1.5", "line": 1.5, "goals": 1,
     "min": 60, "max": 75, "rec_max": 67, "need_vu": True, "min_shots": 15,
     "partial": "son5iki/ustAdayi not in feed"},
]
RISK_MINUTE = 70  # same cut as the worker's risk tier for late signals
# Radar X adds a flat bonus when the live Over is priced as favourite
# (over odds < under odds); see reports/2026-10-05-goal-drivers.md.
RADAR_MARKET_BONUS = 124.7
GOAL_SCORE_MIN_MINUTE = 50
GOAL_SCORE_MIN_PREMIUM = -2  # band "-2..0" and better: >= ~75% historical goal rate


def to_float(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def pair_sum(value):
    if not isinstance(value, list) or len(value) < 2:
        return None
    a, b = to_float(value[0]), to_float(value[1])
    return None if a is None or b is None else a + b


def load_rules():
    with open(RULES_PATH, encoding="utf-8") as f:
        rules = json.load(f)
    rules["goal_score"] = None
    if os.path.exists(GOAL_SCORE_PATH):
        with open(GOAL_SCORE_PATH, encoding="utf-8") as f:
            rules["goal_score"] = json.load(f)
    return rules


def fetch_feed():
    url = FEED_URL.format(ts=int(time.time() * 1000))
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (live_radar.py; personal calibration)",
        "Referer": "https://inplayflux.com/live-scanner?page=open&lang=en",
        "X-Requested-With": "XMLHttpRequest",
    })
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def snapshot(match):
    """Flatten one feed entry into the values our rules and models use."""
    ou = match.get("ou_odds") or []
    minute = to_float(match.get("minute"))
    goals_h = int(to_float(match.get("hg")) or 0)
    goals_a = int(to_float(match.get("ag")) or 0)
    over_odds = to_float(ou[0]) if len(ou) > 0 else None
    under_odds = to_float(ou[1]) if len(ou) > 1 else None
    last_goal = to_float(match.get("sonGolDakikasi")) or 0
    kickoff = match.get("p_odds") or []
    fav_margin = None
    if len(kickoff) > 2 and to_float(kickoff[0]) and to_float(kickoff[2]):
        fav_home = to_float(kickoff[0]) < to_float(kickoff[2])
        fav_margin = goals_h - goals_a if fav_home else goals_a - goals_h
    return {
        "id": match.get("id"),
        "league": match.get("l", ""),
        "match": f"{match.get('h', '?')} vs {match.get('a', '?')}",
        "minute": minute,
        "goals_h": goals_h,
        "goals_a": goals_a,
        "sot": pair_sum(match.get("so")),
        "shots": pair_sum(match.get("ar")),
        "radar": to_float(match.get("xg")),
        "goalline_pre": to_float(match.get("p_goal")),
        "ht_line_pre": to_float(match.get("p_goal_h")),
        "avg_conc": pair_sum(match.get("p_avg_g_c")),
        "since_goal": None if minute is None else minute - last_goal,
        "fav_margin": fav_margin,
        "over_fav": bool(over_odds and under_odds and over_odds < under_odds),
        "over_odds": over_odds,
        "live_line": to_float(ou[2]) if len(ou) > 2 else None,
        "vu": to_float(match.get("vu")) == 1,
        "value": to_float(match.get("value")) == 1,
        "red_cards": (to_float(match.get("hrc")) or 0) + (to_float(match.get("arc")) or 0),
        "phase": match.get("phase", ""),
    }


def model_proba(models, line, s):
    model = models.get(str(line))
    x = [s["minute"], s["sot"], s["radar"], s["goalline_pre"]]
    if not model or any(v is None for v in x):
        return None, None
    z = model["intercept"]
    for xi, mean, std, coef in zip(x, model["mean"], model["std"], model["coef"]):
        z += (xi - mean) / std * coef
    return 1 / (1 + math.exp(-z)), model["threshold"]


def bucket_wr(calib, line, s):
    """Historical win rate for this minute (and SoT for O3.5) bucket."""
    minute = s["minute"]
    if line == 3.5:
        sot_key = "9+" if (s["sot"] or 0) >= 9 else "<=8"
        for b in calib["o35Matrix"]:
            if b["minMin"] <= minute <= b["maxMin"] and b["sot"] == sot_key:
                return b["wr"] / 100, f"{b['label']} SoT{sot_key}", b["n"]
        return None, None, None
    key = {2.5: "o25Buckets", 1.5: "o15Buckets", 0.5: "o05Buckets"}[line]
    for b in calib[key]:
        if b["min"] <= minute <= b["max"]:
            return b["wr"] / 100, b["label"], b["n"]
    return None, None, None


def goal_score_conditions(s):
    """Same conditions as score_conditions() in scripts/goal_drivers.py."""
    m, line, ht = s["minute"], s["goalline_pre"], s["ht_line_pre"]
    return {
        "min_58_62": 58 <= m <= 62,
        "min_63_65": 63 <= m <= 65,
        "min_66p": m >= 66,
        "line_lo": line is not None and line <= 2.5,
        "line_hi": line is not None and line >= 3.25,
        "ht_hi": ht is not None and ht >= 1.5,
        "def_strong": s["avg_conc"] is not None and s["avg_conc"] <= 2.2,
        "sot9": (s["sot"] or 0) >= 9,
        "recent_goal": s["since_goal"] is not None and s["since_goal"] <= 5,
        "over_odds_hi": s["over_odds"] is not None and s["over_odds"] > 2.03,
        "fav_up1": s["fav_margin"] == 1,
    }


CONDITION_LABELS = {
    "min_58_62": "58-62'", "min_63_65": "63-65'", "min_66p": "66'+",
    "line_lo": "Vorab-Linie<=2.5", "line_hi": "Vorab-Linie>=3.25", "ht_hi": "HT-Linie>=1.5",
    "def_strong": "starke Abwehren", "sot9": "SoT>=9", "recent_goal": "Tor <=5 min her",
    "over_odds_hi": "Over-Quote>2.03", "fav_up1": "Favorit führt mit 1",
}


def goal_score(s, gs):
    """Points-based chance that one more goal falls (calibration/goal_score.json)."""
    # Calibrated on signals fired from ~55' on; earlier in the match it says nothing.
    if not gs or s["minute"] is None or s["minute"] < GOAL_SCORE_MIN_MINUTE:
        return None, None, []
    active = [k for k, on in goal_score_conditions(s).items() if on and gs["points"].get(k)]
    points = sum(gs["points"][k] for k in active)
    wr = next((b["wr"] for b in gs["bands"].values() if b["min"] <= points <= b["max"]), None)
    labels = [f"{CONDITION_LABELS[k]} {gs['points'][k]:+d}" for k in active]
    return points, wr, labels


def radar_split(s):
    """Radar X = market bonus (live Over priced as favourite) + game part."""
    if s["radar"] is None:
        return None, None
    market = RADAR_MARKET_BONUS if s["over_fav"] else 0.0
    return market, s["radar"] - market


def check_strategy(strat, s):
    if s["minute"] is None:
        return False
    if s["goals_h"] + s["goals_a"] != strat["goals"]:
        return False
    if not strat["min"] <= s["minute"] <= strat["max"]:
        return False
    if strat.get("need_vu") and not s["vu"]:
        return False
    if strat.get("need_value") and not s["value"]:
        return False
    if strat.get("min_shots") and (s["shots"] or 0) < strat["min_shots"]:
        return False
    return True


def evaluate(s, strat, rules):
    line = strat["line"]
    proba, threshold = model_proba(rules["live_confidence_models"], line, s)
    wr, bucket_label, bucket_n = bucket_wr(rules["tool_calibration"], line, s)
    # Combine model and bucket: the model is the sharper per-match estimate,
    # the bucket is the larger-sample sanity anchor. Use the lower of the two
    # so a hot model can't talk us into a historically weak minute.
    estimates = [p for p in (proba, wr) if p is not None]
    est = min(estimates) if estimates else None
    breakeven = 1 / est if est else None

    odds_ok = None
    edge = None
    if s["over_odds"] and s["live_line"] == line and est:
        edge = est * s["over_odds"] - 1
        odds_ok = s["over_odds"] >= breakeven

    reasons = []
    late = s["minute"] >= RISK_MINUTE
    beyond_rec = strat["rec_max"] is not None and s["minute"] > strat["rec_max"]
    if beyond_rec:
        reasons.append(f"nach empf. Grenze {strat['rec_max']}'")
    if late:
        reasons.append("Spätsignal")
    if s["red_cards"]:
        reasons.append("Rote Karte")
    if strat.get("partial"):
        reasons.append(strat["partial"])
    if odds_ok is False:
        reasons.append("Quote unter Mindestquote")
    if s["live_line"] is not None and s["live_line"] != line:
        reasons.append(f"Live-Linie {s['live_line']} ≠ Ziel {line}")

    points, goal_wr, goal_labels = goal_score(s, rules.get("goal_score"))
    weak_goal_score = points is not None and points < GOAL_SCORE_MIN_PREMIUM
    if weak_goal_score:
        reasons.append(f"Tor-Score {points:+d}")

    passes = proba is not None and proba >= threshold
    if (passes and not beyond_rec and not late and odds_ok is not False and not s["red_cards"]
            and not weak_goal_score):
        verdict = "PREMIUM"
    elif late or beyond_rec or odds_ok is False or (proba is not None and proba < 0.6):
        verdict = "RISIKO"
    else:
        verdict = "OK"

    return {
        "verdict": verdict, "strategy": strat["name"], "line": line,
        "proba": proba, "threshold": threshold, "bucket_wr": wr,
        "bucket": bucket_label, "bucket_n": bucket_n, "estimate": est,
        "breakeven": breakeven, "edge": edge, "reasons": reasons,
        "goal_points": points, "goal_wr": goal_wr, "goal_labels": goal_labels,
    }


def watchlist_hint(s):
    """Matches about to enter a strategy window, so you can open them early."""
    if s["minute"] is None or not s["vu"]:
        return None
    goals = s["goals_h"] + s["goals_a"]
    for strat in STRATEGIES:
        if strat.get("need_vu") and goals == strat["goals"] and strat["min"] - 6 <= s["minute"] < strat["min"]:
            return f"bald im Fenster: {strat['name']} ab {strat['min']}'"
    return None


def fmt_pct(x):
    return "  -  " if x is None else f"{x * 100:4.1f}%"


def fmt_num(x, digits=2):
    return "-" if x is None else f"{x:.{digits}f}"


def fmt_goal(points, wr):
    return "-" if points is None else f"{points:+d}/{wr * 100:.0f}%"


ORDER = {"PREMIUM": 0, "OK": 1, "RISIKO": 2}


def scan(feed, rules, show_all=False):
    hits, watch, rest = [], [], []
    for match in feed:
        s = snapshot(match)
        s["goal_points"], s["goal_wr"], s["goal_labels"] = goal_score(s, rules.get("goal_score"))
        matched = [evaluate(s, strat, rules) for strat in STRATEGIES if check_strategy(strat, s)]
        if matched:
            for ev in matched:
                hits.append((s, ev))
        else:
            hint = watchlist_hint(s)
            (watch if hint else rest).append((s, hint))
    hits.sort(key=lambda h: (ORDER[h[1]["verdict"]], -(h[1]["estimate"] or 0)))
    return hits, watch, rest if show_all else []


def print_report(hits, watch, rest, n_feed):
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"\n=== InPlayFlux Live-Radar {now} · {n_feed} Spiele im Feed · {len(hits)} Signal(e) ===")
    if hits:
        print(f"{'Urteil':8} {'Min':>3} {'Score':5} {'Spiel':42} {'Strategie':32} "
              f"{'Modell':>6} {'Schw.':>5} {'Bucket':>6} {'Mind.Q':>6} {'Quote':>5} {'Edge':>6} "
              f"{'Radar':>6} {'Markt':>5} {'SoT':>3} {'Tor-Sc':>6}  Hinweise")
        for s, ev in hits:
            print(f"{ev['verdict']:8} {int(s['minute']):>3} {s['goals_h']}-{s['goals_a']:<3} "
                  f"{s['match'][:42]:42} {ev['strategy'][:32]:32} {fmt_pct(ev['proba']):>6} "
                  f"{fmt_pct(ev['threshold']):>5} {fmt_pct(ev['bucket_wr']):>6} "
                  f"{fmt_num(ev['breakeven']):>6} {fmt_num(s['over_odds']):>5} "
                  f"{fmt_pct(ev['edge']):>6} {fmt_num(s['radar'], 0):>6} "
                  f"{'+125' if s['over_fav'] else '0':>5} {fmt_num(s['sot'], 0):>3} "
                  f"{fmt_goal(ev['goal_points'], ev['goal_wr']):>6}  {'; '.join(ev['reasons'])}")
            if ev["goal_labels"]:
                print(f"{'':9}Tor-Score: {', '.join(ev['goal_labels'])}")
    else:
        print("Keine Spiele erfüllen gerade eine Strategie-Regel.")
    if watch:
        print("\n--- Beobachten ---")
        for s, hint in watch:
            print(f"{int(s['minute']):>3}' {s['goals_h']}-{s['goals_a']}  {s['match'][:45]:45} "
                  f"Radar {fmt_num(s['radar'], 0):>5}  SoT {fmt_num(s['sot'], 0):>2}  "
                  f"Tor-Score {fmt_goal(s['goal_points'], s['goal_wr']):>7}  {hint}")
    if rest:
        print("\n--- Übrige Live-Spiele ---")
        for s, _ in rest:
            minute = "-" if s["minute"] is None else int(s["minute"])
            print(f"{minute:>3}' {s['goals_h']}-{s['goals_a']}  {s['match'][:45]:45} "
                  f"Radar {fmt_num(s['radar'], 0):>5} (Markt {'+125' if s['over_fav'] else '   0'})  "
                  f"SoT {fmt_num(s['sot'], 0):>2}  Tor-Score {fmt_goal(s['goal_points'], s['goal_wr']):>7}  "
                  f"MoneyBag {'ja' if s['vu'] else 'nein'}")


LOG_FIELDS = ["logged_at", "match_id", "league", "match", "strategy", "line", "minute",
              "score", "radar", "sot", "goalline_pre", "over_odds", "live_line",
              "proba", "bucket_wr", "breakeven", "edge", "goal_points", "goal_wr", "verdict", "reasons",
              "result", "result_minute"]


def read_log(path):
    if not os.path.exists(path):
        return []
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def write_log(path, rows):
    tmp = path + ".tmp"
    with open(tmp, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=LOG_FIELDS)
        w.writeheader()
        w.writerows(rows)
    os.replace(tmp, path)


def update_log(path, hits, feed, last_seen):
    """Append first sighting of each (match, strategy) and settle open ones:
    won as soon as total goals exceed the line; lost once the match has
    dropped out of the live feed after being seen at minute 85+."""
    rows = read_log(path)
    known = {(r["match_id"], r["strategy"]) for r in rows}
    now = datetime.now().isoformat(timespec="seconds")
    for s, ev in hits:
        if (s["id"], ev["strategy"]) in known:
            continue
        rows.append({
            "logged_at": now, "match_id": s["id"], "league": s["league"], "match": s["match"],
            "strategy": ev["strategy"], "line": ev["line"], "minute": int(s["minute"]),
            "score": f"{s['goals_h']}-{s['goals_a']}", "radar": s["radar"], "sot": s["sot"],
            "goalline_pre": s["goalline_pre"], "over_odds": s["over_odds"],
            "live_line": s["live_line"], "proba": fmt_num(ev["proba"], 3),
            "bucket_wr": fmt_num(ev["bucket_wr"], 3), "breakeven": fmt_num(ev["breakeven"]),
            "edge": fmt_num(ev["edge"], 3), "goal_points": ev["goal_points"],
            "goal_wr": fmt_num(ev["goal_wr"], 3), "verdict": ev["verdict"],
            "reasons": "; ".join(ev["reasons"]), "result": "pending", "result_minute": "",
        })
    current = {m.get("id"): snapshot(m) for m in feed}
    for r in rows:
        if r["result"] != "pending":
            continue
        s = current.get(r["match_id"])
        if s is not None:
            last_seen[r["match_id"]] = s["minute"]
            if s["goals_h"] + s["goals_a"] > float(r["line"]):
                r["result"], r["result_minute"] = "won", int(s["minute"] or 0)
        elif (last_seen.get(r["match_id"]) or 0) >= 85:
            r["result"] = "lost"
    write_log(path, rows)
    settled = [r for r in rows if r["result"] in ("won", "lost")]
    if settled:
        for verdict in ("PREMIUM", "OK", "RISIKO"):
            group = [r for r in settled if r["verdict"] == verdict]
            if group:
                won = sum(r["result"] == "won" for r in group)
                print(f"Log {verdict}: {won}/{len(group)} gewonnen ({won / len(group) * 100:.1f}%)")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--file", help="read a saved GETAllMatches JSON instead of fetching")
    ap.add_argument("--watch", type=int, metavar="SEK", help=f"repeat every SEK seconds (min {MIN_POLL_SECONDS})")
    ap.add_argument("--log", help="CSV to record signals and settle their results")
    ap.add_argument("--all", action="store_true", help="also list live matches without a hit")
    ap.add_argument("--save", help="save the raw feed JSON to this path")
    args = ap.parse_args()

    rules = load_rules()
    last_seen = {}
    interval = max(args.watch or 0, MIN_POLL_SECONDS)
    while True:
        try:
            if args.file:
                with open(args.file, encoding="utf-8") as f:
                    feed = json.load(f)
            else:
                feed = fetch_feed()
        except Exception as e:  # network hiccup: report and retry in watch mode
            print(f"Feed-Fehler: {e}", file=sys.stderr)
            if not args.watch:
                sys.exit(1)
            time.sleep(interval)
            continue
        if args.save:
            with open(args.save, "w", encoding="utf-8") as f:
                json.dump(feed, f, ensure_ascii=False)
        hits, watch, rest = scan(feed, rules, args.all)
        print_report(hits, watch, rest, len(feed))
        if args.log:
            update_log(args.log, hits, feed, last_seen)
        if not args.watch or args.file:
            break
        time.sleep(interval)


if __name__ == "__main__":
    main()
