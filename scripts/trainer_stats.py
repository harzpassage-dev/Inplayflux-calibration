# Zahlen für TikTok-Video 9 ("Trainer-Sprüche im Daten-Check"). Pro Spiel (Tag + Name) zählt die
# früheste Szene zwischen Minute 55 und 65 (Halbzeit-Karten ausgenommen). "noch ein Tor" = Anteil der
# Spiele, in denen danach bis zum Abpfiff noch ein Tor fiel; Nachspielzeit = nächstes Tor nach Minute 90.
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
s['st']=s.apply(lambda r:f'{int(max(r.h,r.a))}:{int(min(r.h,r.a))}',axis=1)
print('Spiele',len(s),s.t.min().date(),'..',s.t.max().date(),'Median-Minute',s.mn.median())
for half,m in [('ALLE',s.t>'2000'),('bis 27.9.',s.t<='2026-09-27'),('ab 28.9.',s.t>'2026-09-27')]:
  x=s[m]; w=x[x.win]
  print(f'\n{half}: {len(x)} Spiele, noch ein Tor {x.win.mean()*100:.1f} %, nächstes Tor in der Nachspielzeit {(w.rm>90).mean()*100:.1f} % der Tore, '
        f'nach Minute 85 {(w.rm>85).mean()*100:.1f} %, Median Wartezeit {(w.rm-w.mn).median()}')
  for st in ['0:0','1:0','1:1','2:0','2:1','3:0']:
    q=x[x.st==st]; print(f'  {st}: n={len(q)}, noch ein Tor {q.win.mean()*100:.1f} %, bleibt {100-q.win.mean()*100:.1f} %')
