# Zahlen für TikTok-Video 14 ("U18, U20, U21 – fallen bei der Jugend mehr Tore?").
# Altersklasse aus Liga- oder Spielname (U17–U19 / U20–U23); Herren = keine Jugend, keine Reserve, keine Frauen.
# Pro Spiel (Tag + Name) zählt die früheste Szene mit Minute 55–65. Hälften: vor / ab 01.10.2026.
import pandas as pd,glob,re
d=pd.concat([pd.read_csv(f,dtype=str) for f in sorted(glob.glob('data/*.csv'))],ignore_index=True)
c=lambda k:[x for x in d.columns if x.startswith(k)][0]
d=d.drop_duplicates([c('Tarih'),c('Maç'),c('Strateji'),c('Sinyal Dk')]).reset_index(drop=True)
d=d[d[c('Sonuç (')].str.contains('WON|LOST',case=False,na=False)].reset_index(drop=True)
num=lambda k:pd.to_numeric(d[c(k)].astype(str).str.replace('=','').str.replace('"',''),errors='coerce')
win=d[c('Sonuç (')].str.contains('WON',case=False); mn=num('Sinyal Dk'); rm=num('Sonuç Dk')
sc=d[c('Skor')].str.extract(r'(\d+)\s*-\s*(\d+)').astype(float); tot=sc[0]+sc[1]
t=pd.to_datetime(d[c('Tarih')].str.extract(r'(\d{4}-\d\d-\d\d)')[0]); A=t<'2026-10-01'
lg=d[c('Lig')].astype(str).str.replace('=','').str.replace('"','').str.strip(); match=d[c('Maç')].astype(str)
ht=d[c('Hedef')].astype(str).str.match(r'\s*HT\b')|d[c('Strateji')].astype(str).str.contains(r'Iy gol|^\s*HT\s',regex=True)
women=match.str.contains(r'\(W\)|Women|Feminin',case=False)|lg.str.contains('Women|Feminin|Frauen|Damen|W-League|NWSL|WSL',case=False)
age=(lg+' '+match).str.extract(r'\bU-?(\d\d)\b',flags=re.I)[0].astype(float)
reserve=lg.str.contains('Reserve|Primavera|Youth|Junior|II\\b',case=False)|match.str.contains('Reserve',case=False)
grp=pd.Series(None,index=d.index,dtype=object)
grp[(age>=17)&(age<=19)]='U17-U19'; grp[(age>=20)&(age<=23)]='U20-U23'; grp[age.isna()&~reserve&~women]='Herren'
grp[women]=None
s=pd.DataFrame(dict(g=grp,win=win,mn=mn,rm=rm,tot=tot,A=A,ht=ht,key=t.dt.date.astype(str)+'|'+match,lg=lg,age=age))
s=s[s.g.notna()&~s.ht&s.mn.between(55,65)].sort_values('mn').drop_duplicates('key')
print('Zeitraum',t.min().date(),'bis',t.max().date())
for half,m in [('ALLE',s.A|~s.A),('vor 1.10.',s.A),('ab 1.10.',~s.A)]:
  for g in ['U17-U19','U20-U23','Herren']:
    x=s[m&(s.g==g)]; w=x[x.win]
    print(f"{half:10s} {g:8s} Spiele {len(x):5d} Ligen {x.lg.nunique():4d} Tore/90 bis Szene {(x.tot/x.mn*90).mean():.2f}"
          f"  noch ein Tor {x.win.mean()*100:5.1f}%  Median Warten {(w.rm-w.mn).median():4.0f}  Nachspielzeit {(w.rm>90).mean()*100:4.1f}%"
          f"  Minute {x.mn.median():.0f}")
print(s[s.g!='Herren'].age.value_counts().sort_index().to_dict())
