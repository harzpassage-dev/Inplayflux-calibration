# Zahlen für TikTok-Video 11 ("So entstehen unsere Zahlen"). Pro Spiel (Tag + Name) zählt die früheste
# Szene zwischen Minute 55 und 65 (Halbzeit-Karten ausgenommen). Beispiel: 0:0 um Minute 60, getrennt nach
# den erwarteten Toren vor dem Anpfiff (Spalte "MÖ Gol Baremi"); Hälften getrennt bei 2026-10-01.
import pandas as pd,glob
d=pd.concat([pd.read_csv(f,dtype=str) for f in sorted(glob.glob('data/*.csv'))],ignore_index=True)
c=lambda k:[x for x in d.columns if x.startswith(k)][0]
d=d.drop_duplicates([c('Tarih'),c('Maç'),c('Strateji'),c('Sinyal Dk')]).reset_index(drop=True)
d=d[d[c('Sonuç (')].str.contains('WON|LOST',case=False,na=False)&~d[c('Hedef')].astype(str).str.match(r'\s*HT')].reset_index(drop=True)
num=lambda k:pd.to_numeric(d[c(k)].astype(str).str.replace('=','').str.replace('"',''),errors='coerce')
sc=d[c('Skor')].str.extract(r'(\d+)\s*-\s*(\d+)').astype(float)
t=pd.to_datetime(d[c('Tarih')].str.extract(r'(\d{4}-\d\d-\d\d)')[0])
s=pd.DataFrame(dict(g=sc[0]+sc[1],mn=num('Sinyal Dk'),line=num('MÖ Gol Baremi'),win=d[c('Sonuç (')].str.contains('WON',case=False),
  key=t.dt.date.astype(str)+'|'+d[c('Maç')],t=t)).dropna(subset=['g','mn'])
s=s[(s.mn>=55)&(s.mn<=65)].sort_values('mn').drop_duplicates('key')
print('Spiele',len(s),s.t.min().date(),'..',s.t.max().date())
z=s[s.g==0]; print('0:0-Spiele',len(z))
for lab,m in [('bis 2,5',z.line<=2.5),('2,75-3,5',z.line.between(2.75,3.5)),('ab 3,75',z.line>=3.75),('ab 4',z.line>=4)]:
  x=z[m]; a,b=x[x.t<'2026-10-01'],x[x.t>='2026-10-01']
  print(f'  {lab:9s} n={len(x):4d} {x.win.mean()*100:5.1f}%  Hälften {a.win.mean()*100:5.1f}% (n{len(a)}) / {b.win.mean()*100:5.1f}% (n{len(b)})')
