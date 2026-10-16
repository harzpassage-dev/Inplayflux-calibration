# Zahlen für TikTok-Video 5 (Auswechseln / Joker-Phase): Torgefahr pro Minute ab Minute 60.
# Pro Spiel (Tag + Spielname) nur die früheste Szene zwischen Minute 58 und 63.
# Gemessen wird nur das NÄCHSTE Tor nach der Szene, daher Hazard: Tore im Fenster /
# Spiele, die zu Fensterbeginn noch ohne neues Tor waren / Fensterminuten.
import pandas as pd,glob
d=pd.concat([pd.read_csv(f,dtype=str) for f in sorted(glob.glob('data/*.csv'))],ignore_index=True)
c=lambda k:[x for x in d.columns if x.startswith(k)][0]
d=d.drop_duplicates([c('Tarih'),c('Maç'),c('Strateji'),c('Sinyal Dk')]).reset_index(drop=True)
d=d[d[c('Sonuç (')].str.contains('WON|LOST',case=False,na=False)].reset_index(drop=True)
win=d[c('Sonuç (')].str.contains('WON',case=False)
num=lambda k:pd.to_numeric(d[c(k)].astype(str).str.replace('=','').str.replace('"',''),errors='coerce')
mn=num('Sinyal Dk'); rm=num('Sonuç Dk')
t=pd.to_datetime(d[c('Tarih')].str.extract(r'(\d{4}-\d\d-\d\d)')[0]); A=t<='2026-09-27'
key=t.dt.date.astype(str)+'|'+d[c('Maç')].astype(str)
s=d.assign(win=win,mn=mn,rm=rm,A=A,key=key)
s=s[(s.mn>=58)&(s.mn<=63)].sort_values('mn').drop_duplicates('key')
W=[('61–75',61,75),('76–90',76,90)]
def haz(x,lab):
  n=len(x); out=[]
  for nm,lo,hi in W:
    at_risk=((~x.win)|(x.rm>=lo)).sum()
    g=(x.win&(x.rm>=lo)&(x.rm<=hi)).sum()
    out.append((nm,int(g),int(at_risk),round(g/at_risk/(hi-lo+1)*100,2)))
  st=(x.win&(x.rm>90)).sum()
  print(lab,'matches',n,'goal after',round(x.win.mean()*100,1),'%',out,'90+ goals',int(st),round(st/n*100,1),'%')
haz(s,'ALL'); haz(s[s.A],'A  '); haz(s[~s.A],'B  ')
g=s.rm[s.win]
print('next goal share of goals: 61-75',round(((g<=75)).mean()*100,1),'76-90+',round((g>75).mean()*100,1))
