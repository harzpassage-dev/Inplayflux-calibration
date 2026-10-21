# Zahlen für TikTok-Video 10 ("Knapp oder klar – wann fällt das nächste Tor?"). Pro Spiel (Tag + Name)
# zählt die früheste Szene zwischen Minute 55 und 65 (Halbzeit-Karten ausgenommen). Gruppen nach
# Tordifferenz: Gleichstand mit Toren (1:1, 2:2, …), 1 Tor Unterschied, 2+ Tore Unterschied; 0:0 extra.
import pandas as pd,glob
d=pd.concat([pd.read_csv(f,dtype=str) for f in sorted(glob.glob('data/*.csv'))],ignore_index=True)
c=lambda k:[x for x in d.columns if x.startswith(k)][0]
d=d.drop_duplicates([c('Tarih'),c('Maç'),c('Strateji'),c('Sinyal Dk')]).reset_index(drop=True)
d=d[d[c('Sonuç (')].str.contains('WON|LOST',case=False,na=False)&~d[c('Hedef')].astype(str).str.match(r'\s*HT')].reset_index(drop=True)
num=lambda k:pd.to_numeric(d[c(k)].astype(str).str.replace('=','').str.replace('"',''),errors='coerce')
sc=d[c('Skor')].str.extract(r'(\d+)\s*-\s*(\d+)').astype(float)
t=pd.to_datetime(d[c('Tarih')].str.extract(r'(\d{4}-\d\d-\d\d)')[0])
s=pd.DataFrame(dict(h=sc[0],a=sc[1],mn=num('Sinyal Dk'),rm=num('Sonuç Dk'),win=d[c('Sonuç (')].str.contains('WON',case=False),
  key=t.dt.date.astype(str)+'|'+d[c('Maç')],t=t)).dropna(subset=['h','a','mn'])
s=s[(s.mn>=55)&(s.mn<=65)].sort_values('mn').drop_duplicates('key')
s['diff']=(s.h-s.a).abs(); s['goals']=s.h+s.a
s['grp']=s.apply(lambda r:'0:0' if r.goals==0 else 'Gleichstand' if r['diff']==0 else '1 Tor' if r['diff']==1 else '2+ Tore',axis=1)
mid='2026-10-01'
print('Spiele',len(s),s.t.min().date(),'..',s.t.max().date(),'Median-Minute',s.mn.median(),'Hälften getrennt bei',mid)
for half,m in [('ALLE',s.t>'2000'),('1. Hälfte',s.t<mid),('2. Hälfte',s.t>=mid)]:
  x=s[m]; print(f'\n{half}: {len(x)} Spiele')
  for g in ['0:0','Gleichstand','1 Tor','2+ Tore']:
    q=x[x.grp==g]; w=q[q.win]
    print(f'  {g:12s} n={len(q):5d}  noch ein Tor {q.win.mean()*100:5.1f} %  | von diesen Toren: 61-75 {((w.rm<=75)).mean()*100:4.1f} %, 76-90 {((w.rm>75)&(w.rm<=90)).mean()*100:4.1f} %, Nachspielzeit {(w.rm>90).mean()*100:4.1f} %  | nach 75. {(w.rm>75).mean()*100:4.1f} % | Median Wartezeit {(w.rm-w.mn).median()}')
