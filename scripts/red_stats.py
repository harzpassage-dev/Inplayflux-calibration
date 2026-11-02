# Zahlen für TikTok-Video 16 ("Rote Karte = mehr Tore?").
# Pro Spiel (Tag + Name) zählt die früheste Szene mit Minute 55–65. Rote Karten = bis zur Szene (beide Teams).
# Hälften: vor / ab 01.10.2026. Wer danach trifft (Team mit 10 oder 11 Mann), steht nicht in den Daten.
import pandas as pd,glob
d=pd.concat([pd.read_csv(f,dtype=str) for f in sorted(glob.glob('data/*.csv'))],ignore_index=True)
c=lambda k:[x for x in d.columns if x.startswith(k)][0]
d=d.drop_duplicates([c('Tarih'),c('Maç'),c('Strateji'),c('Sinyal Dk')]).reset_index(drop=True)
d=d[d[c('Sonuç (')].str.contains('WON|LOST',case=False,na=False)].reset_index(drop=True)
num=lambda k:pd.to_numeric(d[c(k)].astype(str).str.replace('=','').str.replace('"',''),errors='coerce')
win=d[c('Sonuç (')].str.contains('WON',case=False); mn=num('Sinyal Dk'); rm=num('Sonuç Dk')
sc=d[c('Skor')].str.extract(r'(\d+)\s*-\s*(\d+)').astype(float); tot=sc[0]+sc[1]
red=num('Kırmızı Kart Ev').fillna(0)+num('Kırmızı Kart Dep').fillna(0)
t=pd.to_datetime(d[c('Tarih')].str.extract(r'(\d{4}-\d\d-\d\d)')[0]); A=t<'2026-10-01'
ht=d[c('Hedef')].astype(str).str.match(r'\s*HT\b')|d[c('Strateji')].astype(str).str.contains(r'Iy gol|^\s*HT\s',regex=True)
s=pd.DataFrame(dict(win=win,mn=mn,rm=rm,tot=tot,red=red,A=A,ht=ht,key=t.dt.date.astype(str)+'|'+d[c('Maç')].astype(str)))
s=s[~s.ht&s.mn.between(55,65)].sort_values('mn').drop_duplicates('key')
print('Zeitraum',t.min().date(),'bis',t.max().date(),'Spiele',len(s))
grp=[('0 Rot',s.red==0),('1 Rot',s.red==1),('2+ Rot',s.red>=2),('1+ Rot',s.red>=1)]
for half,m in [('ALLE',s.A|~s.A),('vor 1.10.',s.A),('ab 1.10.',~s.A)]:
  for g,gm in grp:
    x=s[m&gm]; w=x[x.win]
    if len(x)==0: continue
    print(f"{half:10s} {g:7s} Spiele {len(x):5d}  Anteil {len(x)/m.sum()*100:4.1f}%  Tore bis Szene {x.tot.mean():.2f}"
          f"  noch ein Tor {x.win.mean()*100:5.1f}%  Median Warten {(w.rm-w.mn).median():4.0f}  nach 85' {(w.rm>85).mean()*100:4.1f}%"
          f"  Minute {x.mn.median():.0f}")
