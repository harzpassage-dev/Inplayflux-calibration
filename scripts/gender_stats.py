# Zahlen für TikTok-Video 7 ("Wer schießt mehr Tore – Frauen oder Männer?").
# Frauen/Herren wie in country_stats.py (Jugend ausgenommen). Pro Spiel (Tag + Name) zählt
# die früheste Szene. Saison-Torschnitt = Ort Gol Atar Ev + Dep (Tore pro Spiel beider Teams).
import pandas as pd,glob
d=pd.concat([pd.read_csv(f,dtype=str) for f in sorted(glob.glob('data/*.csv'))],ignore_index=True)
c=lambda k:[x for x in d.columns if x.startswith(k)][0]
d=d.drop_duplicates([c('Tarih'),c('Maç'),c('Strateji'),c('Sinyal Dk')]).reset_index(drop=True)
d=d[d[c('Sonuç (')].str.contains('WON|LOST',case=False,na=False)].reset_index(drop=True)
num=lambda k:pd.to_numeric(d[c(k)].astype(str).str.replace('=','').str.replace('"',''),errors='coerce')
win=d[c('Sonuç (')].str.contains('WON',case=False); mn=num('Sinyal Dk'); rm=num('Sonuç Dk')
sc=d[c('Skor')].str.extract(r'(\d+)\s*-\s*(\d+)').astype(float); tot=sc[0]+sc[1]
avg=num('Ort Gol Atar Ev')+num('Ort Gol Atar Dep')
t=pd.to_datetime(d[c('Tarih')].str.extract(r'(\d{4}-\d\d-\d\d)')[0]); A=t<='2026-09-27'
lg=d[c('Lig')].astype(str).str.replace('=','').str.replace('"','').str.strip(); match=d[c('Maç')].astype(str)
women=match.str.contains(r'\(W\)|Women|Feminin',case=False)|lg.str.contains('Women|Feminin|Frauen|Damen|W-League|NWSL|WSL',case=False)
youth=lg.str.contains(r'U\d\d|Youth|Junior|Primavera|Reserve',case=False)|match.str.contains(r'U\d\d\b',case=False)
grp=pd.Series(None,index=d.index,dtype=object); grp[women]='Frauen'; grp[~youth&~women]='Herren'
s=pd.DataFrame(dict(g=grp,win=win,mn=mn,rm=rm,tot=tot,avg=avg,A=A,key=t.dt.date.astype(str)+'|'+match,lg=lg)).dropna(subset=['g'])
s=s.sort_values('mn').drop_duplicates('key')
for half,m in [('ALL',s.A|~s.A),('A',s.A),('B',~s.A)]:
  for g in ['Frauen','Herren']:
    x=s[m&(s.g==g)]; w=x[x.win]; wait=w.rm-w.mn
    print(half,g,'matches',len(x),'leagues',x.lg.nunique(),'season avg goals/match',round(x.avg.mean(),2),'(n',int(x.avg.notna().sum()),')',
      'another goal',round(x.win.mean()*100,1),'median wait',wait.median(),'stoppage share of goals',round((w.rm>90).mean()*100,1),
      'goals before signal per 90',round((x.tot/x.mn*90).mean(),2))
