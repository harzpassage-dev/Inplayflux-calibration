# "Daten der Woche" 04.11.: another goal after ~60' by the pre-match goal expectation (bookmaker goal line before
# kick-off), all scores. Unique matches (day + name), earliest scene at minute 55–65. Halves: before / from 2026-10-05.
import pandas as pd, glob
d = pd.concat([pd.read_csv(f, dtype=str) for f in sorted(glob.glob('data/*.csv'))], ignore_index=True)
c = lambda k: [x for x in d.columns if x.startswith(k)][0]
d = d.drop_duplicates([c('Tarih'), c('Maç'), c('Strateji'), c('Sinyal Dk')]).reset_index(drop=True)
d = d[d[c('Sonuç (')].str.contains('WON|LOST', case=False, na=False)].reset_index(drop=True)
num = lambda k: pd.to_numeric(d[c(k)].astype(str).str.replace('=', '').str.replace('"', ''), errors='coerce')
win = d[c('Sonuç (')].str.contains('WON', case=False); mn = num('Sinyal Dk'); line = num('MÖ Gol Baremi')
t = pd.to_datetime(d[c('Tarih')].str.extract(r'(\d{4}-\d\d-\d\d)')[0]); A = t < '2026-10-05'
ht = d[c('Hedef')].astype(str).str.match(r'\s*HT\b') | d[c('Strateji')].astype(str).str.contains(r'Iy gol|^\s*HT\s', regex=True)
s = pd.DataFrame(dict(win=win, mn=mn, line=line, A=A, ht=ht, key=t.dt.date.astype(str) + '|' + d[c('Maç')].astype(str)))
s = s[~s.ht & s.mn.between(55, 65) & s.line.notna() & (s.line > 0)].sort_values('mn').drop_duplicates('key')
print('Zeitraum', t.min().date(), 'bis', t.max().date(), 'Spiele', len(s))
bands = [('bis 2,5', 0, 2.5), ('2,75–3,0', 2.75, 3.0), ('3,25–3,5', 3.25, 3.5), ('ab 3,75', 3.75, 99)]
for name, m in [('ALLE', s.A | ~s.A), ('vor 5.10.', s.A), ('ab 5.10.', ~s.A)]:
    for lab, lo, hi in bands:
        x = s[m & s.line.between(lo, hi)]
        print(f"{name:10s} {lab:10s} n={len(x):5d} noch ein Tor {x.win.mean()*100:5.1f}%")
