# Zahlen für TikTok-Video 8 ("Viele Ecken = viele Tore?"). Pro Spiel (Tag + Name) zählt die
# früheste Szene zwischen Minute 50 und 75 (Halbzeit-Karten ausgenommen). Ecken und Tore jeweils
# bis zu dieser Szene; "noch ein Tor" = Anteil der Spiele, in denen danach noch ein Tor fiel.
import pandas as pd,glob,numpy as np
d=pd.concat([pd.read_csv(f,dtype=str) for f in sorted(glob.glob('data/*.csv'))],ignore_index=True)
c=lambda k:[x for x in d.columns if x.startswith(k)][0]
d=d.drop_duplicates([c('Tarih'),c('Maç'),c('Strateji'),c('Sinyal Dk')]).reset_index(drop=True)
d=d[d[c('Sonuç (')].str.contains('WON|LOST',case=False,na=False)&~d[c('Hedef')].astype(str).str.match(r'\s*HT')].reset_index(drop=True)
num=lambda k:pd.to_numeric(d[c(k)].astype(str).str.replace('=','').str.replace('"',''),errors='coerce')
sc=d[c('Skor')].str.extract(r'(\d+)\s*-\s*(\d+)').astype(float)
t=pd.to_datetime(d[c('Tarih')].str.extract(r'(\d{4}-\d\d-\d\d)')[0])
s=pd.DataFrame(dict(h=sc[0],a=sc[1],ch=num('Korner Ev'),ca=num('Korner Dep'),mn=num('Sinyal Dk'),
  win=d[c('Sonuç (')].str.contains('WON',case=False),key=t.dt.date.astype(str)+'|'+d[c('Maç')],t=t)).dropna(subset=['h','a','ch','ca','mn'])
s=s[(s.mn>=50)&(s.mn<=75)].sort_values('mn').drop_duplicates('key')
print('Spiele',len(s),s.t.min().date(),'..',s.t.max().date(),'Median-Minute',s.mn.median())
for half,m in [('ALLE',s.t>'2000'),('bis 27.9.',s.t<='2026-09-27'),('ab 28.9.',s.t>'2026-09-27')]:
  x=s[m]; tc=x.ch+x.ca; dc=x.ch-x.ca; dg=x.h-x.a
  print(f'\n{half}: {len(x)} Spiele, Ø Ecken {tc.mean():.1f}, Ø Tore {(x.h+x.a).mean():.2f}, Korrelation Ecken/Tore {tc.corr(x.h+x.a):.3f}')
  for lo,hi in [(0,4),(5,8),(9,12)]:
    q=x[(tc>=lo)&(tc<=hi)]
    print(f'  {lo}-{hi} Ecken: n={len(q)}, Tore bis zur Szene {(q.h+q.a).mean():.2f}, noch ein Tor {q.win.mean()*100:.1f} %')
  z=x[dg!=0]; zc=np.sign(z.ch-z.ca); zg=np.sign(z.h-z.a)
  print(f'  Spiele mit Führung n={len(z)}: führendes Team mehr Ecken {(zc==zg).mean()*100:.1f} %, '
        f'zurückliegendes mehr {(zc==-zg).mean()*100:.1f} %, gleich viele {(zc==0).mean()*100:.1f} %')
