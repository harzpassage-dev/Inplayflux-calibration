import pandas as pd,glob,numpy as np
d=pd.concat([pd.read_csv(f,dtype=str) for f in sorted(glob.glob('data/*.csv'))],ignore_index=True)
c=lambda k:[x for x in d.columns if x.startswith(k)][0]
d=d.drop_duplicates([c('Tarih'),c('Maç'),c('Strateji'),c('Sinyal Dk')]).reset_index(drop=True)
r=d[c('Sonuç (')].str.strip()
d=d[r.str.contains('WON|LOST',case=False,na=False)].reset_index(drop=True); win=d[c('Sonuç (')].str.contains('WON',case=False)
sc=d[c('Skor')].str.extract(r'(\d+)\s*-\s*(\d+)').astype(float); h,a=sc[0],sc[1]
oh=pd.to_numeric(d[c('KO Oran Ev')],errors='coerce'); oa=pd.to_numeric(d[c('KO Oran Dep')],errors='coerce')
t=pd.to_datetime(d[c('Tarih')].str.extract(r'(\d{4}-\d\d-\d\d)')[0]); A=t<='2026-09-27'
lg=d[c('Lig')].astype(str).str.replace('=','').str.replace('"','').str.strip()
print(lg.value_counts().head(40))
multi={'South Korea','Costa Rica','El Salvador','Saudi Arabia','Northern Ireland','New Zealand','South Africa','Hong Kong','United Arab Emirates','Faroe Islands','Bosnia and Herzegovina','North Macedonia','Czech Republic'}
def country(x):
  for m in multi:
    if x.startswith(m): return m
  return x.split(' ')[0]
co=lg.map(country)
match=d[c('Maç')].astype(str)
women=match.str.contains(r'\(W\)|Women|Feminin',case=False)|lg.str.contains('Women|Feminin|Frauen|Damen|W-League|NWSL|WSL',case=False)
youth=lg.str.contains(r'U\d\d|Youth|Junior|Primavera|Reserve',case=False)|match.str.contains(r'U\d\d\b',case=False)
def row(lab,m):
  return f'{lab:22s} n={int(m.sum()):5d} {win[m].mean()*100:5.1f}  A {win[m&A].mean()*100:5.1f} (n{int((m&A).sum())}) B {win[m&~A].mean()*100:5.1f} (n{int((m&~A).sum())})'
print(row('ALL',win==win))
for lab,m in [('Frauen',women),('Jugend',youth&~women),('Herren',~youth&~women)]: print(row(lab,m))
vc=co.value_counts(); 
rows=[]
for k,n in vc.items():
  if n<250: continue
  m=co==k; rows.append((win[m].mean(),row(k,m)))
for r in sorted(rows,reverse=True): print(r[1])
# friendlies / cups vs leagues
cup=lg.str.contains('Cup|Pokal|Copa|Coupe|Trophy|Friendl|Qualification|Nations',case=False)
print(row('Pokal/Freundschaft',cup)); print(row('Liga',~cup))
skip={'Europe','International','U19','U20','U21','U23','CONCACAF','UEFA','Africa','European','World','Club','AFC','CONMEBOL','Asia','South','North','FIFA','Copa','Women','Friendlies'}
cs=set(x for x in co.unique() if x not in skip)
print('countries approx',len(cs))
for k in ['Finland','Poland','Norway','Italy','Mexico','Brazil']:
  print(k, lg[co==k].value_counts().head(3).to_dict())
