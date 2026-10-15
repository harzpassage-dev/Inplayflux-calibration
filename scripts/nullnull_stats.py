import pandas as pd,glob,numpy as np
d=pd.concat([pd.read_csv(f,dtype=str) for f in sorted(glob.glob('data/*.csv'))],ignore_index=True)
c=lambda k:[x for x in d.columns if x.startswith(k)][0]
d=d.drop_duplicates([c('Tarih'),c('Maç'),c('Strateji'),c('Sinyal Dk')]).reset_index(drop=True)
r=d[c('Sonuç (')].str.strip()
d=d[r.str.contains('WON|LOST',case=False,na=False)].reset_index(drop=True); win=d[c('Sonuç (')].str.contains('WON',case=False)
sc=d[c('Skor')].str.extract(r'(\d+)\s*-\s*(\d+)').astype(float); h,a=sc[0],sc[1]
oh=pd.to_numeric(d[c('KO Oran Ev')],errors='coerce'); oa=pd.to_numeric(d[c('KO Oran Dep')],errors='coerce')
t=pd.to_datetime(d[c('Tarih')].str.extract(r'(\d{4}-\d\d-\d\d)')[0]); A=t<='2026-09-27'
num=lambda k:pd.to_numeric(d[c(k)].astype(str).str.replace('=','').str.replace('"',''),errors='coerce')
mn=num('Sinyal Dk'); rm=num('Sonuç Dk'); sot=num('Şut İsabetli Ev')+num('Şut İsabetli Dep')
z=(h==0)&(a==0)
print('0-0 scenes',z.sum(),'goal fell',round(win[z].mean()*100,1),'A',round(win[z&A].mean()*100,1),'B',round(win[z&~A].mean()*100,1))
print('minute range',mn[z].describe()[['min','25%','50%','75%','max']].tolist())
for lo,hi in [(0,45),(45,55),(55,60),(60,65),(65,70),(70,95)]:
  m=z&(mn>=lo)&(mn<hi); 
  if m.sum(): print(f'{lo}-{hi}',int(m.sum()),round(win[m].mean()*100,1),'A',round(win[m&A].mean()*100,1) if (m&A).sum() else None,'B',round(win[m&~A].mean()*100,1) if (m&~A).sum() else None)
w=z&win; wait=rm[w]-mn[w]
print('wait median',wait.median(),'q',wait.quantile([.25,.75]).tolist(),'goal min median',rm[w].median())
print('within 10 min',round((wait<=10).mean()*100,1),'within 20',round((wait<=20).mean()*100,1),'stoppage',round((rm[w]>90).mean()*100,1))
for lab,m in [('SoT 0-3',sot<=3),('4-6',(sot>=4)&(sot<=6)),('7+',sot>=7)]:
  m=m&z; print(lab,int(m.sum()),round(win[m].mean()*100,1),'A',round(win[m&A].mean()*100,1),'B',round(win[m&~A].mean()*100,1))
print(d.loc[z,c('Strateji')].value_counts().head())
day=t.dt.date.astype(str); key=day+'|'+d[c('Maç')].astype(str)
u=z&~key.duplicated() 
print('unique matches',u.sum(),'goal',round(win[u].mean()*100,1),'A',round(win[u&A].mean()*100,1),'B',round(win[u&~A].mean()*100,1))
g=rm[u&win]
bins=[('61–70',(g<=70)),('71–80',(g>70)&(g<=80)),('81–90',(g>80)&(g<=90)),('90+',g>90)]
n=u.sum()
for lab,m in bins: print(lab, int(m.sum()), round(m.sum()/n*100,1))
print('kein Tor', int((u&~win).sum()), round((u&~win).sum()/n*100,1))
for nm,tm in [('A',A),('B',~A)]:
  uu=u&tm; gg=rm[uu&win]; nn=uu.sum(); print(nm,[round(x.sum()/nn*100,1) for x in [(gg<=70),(gg>70)&(gg<=80),(gg>80)&(gg<=90),gg>90]], round((uu&~win).sum()/nn*100,1))
