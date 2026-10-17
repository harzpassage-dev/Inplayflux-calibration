# Zahlen für TikTok-Video 6 ("73 % – wie sicher ist das?"): Anteil der Szenen mit weiterem Tor
# und wie lang Serien ohne / mit Tor in zeitlicher Reihenfolge werden (echte Daten vs. Rechnung).
import pandas as pd,glob,math
d=pd.concat([pd.read_csv(f,dtype=str) for f in sorted(glob.glob('data/*.csv'))],ignore_index=True)
c=lambda k:[x for x in d.columns if x.startswith(k)][0]
d=d.drop_duplicates([c('Tarih'),c('Maç'),c('Strateji'),c('Sinyal Dk')]).reset_index(drop=True)
d=d[d[c('Sonuç (')].str.contains('WON|LOST',case=False,na=False)].copy()
d['win']=d[c('Sonuç (')].str.contains('WON',case=False)
d['ts']=pd.to_datetime(d[c('Tarih')].str.extract(r'(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)')[0])
d=d.sort_values('ts').reset_index(drop=True); A=d.ts<='2026-09-27 23:59:59'
p=d.win.mean(); print('scenes',len(d),'rate',round(p*100,1),'A',round(d.win[A].mean()*100,1),'B',round(d.win[~A].mean()*100,1))
def runs(s):
  out={True:[],False:[]};cur=None;n=0
  for v in s:
    if v==cur:n+=1
    else:
      if cur is not None:out[cur].append(n)
      cur=v;n=1
  out[cur].append(n);return out
r=runs(d.win.tolist())
print('longest goal run',max(r[True]),'longest no-goal run',max(r[False]))
nl=pd.Series(r[False]); print('no-goal runs >=3',int((nl>=3).sum()),'>=5',int((nl>=5).sum()),'of',len(nl))
# in blocks of 10 consecutive scenes: how often are >=4 without goal?
b=[d.win[i:i+10] for i in range(0,len(d)-9,10)]
miss=pd.Series([10-x.sum() for x in b]); print('blocks of 10',len(b),'avg miss',round(miss.mean(),2),'share with >=4 miss',round((miss>=4).mean()*100,1),'0 miss',round((miss==0).mean()*100,1))
# theory
for k in [3,5,10]: print('all',k,'with goal theory',round(p**k*100,1))
print('theory >=4 of 10 miss', round(sum(math.comb(10,j)*(1-p)**j*p**(10-j) for j in range(4,11))*100,1),'0 miss',round(p**10*100,1))
# empirical: 5 consecutive scenes all with goal
w=d.win.astype(int).rolling(5).sum(); print('empirical 5 in a row all goal',round((w==5).mean()*100,1))
