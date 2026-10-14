import pandas as pd,glob,numpy as np
d=pd.concat([pd.read_csv(f,dtype=str) for f in sorted(glob.glob('data/*.csv'))],ignore_index=True)
c=lambda k:[x for x in d.columns if x.startswith(k)][0]
d=d.drop_duplicates([c('Tarih'),c('Maç'),c('Strateji'),c('Sinyal Dk')]).reset_index(drop=True)
r=d[c('Sonuç (')].str.strip()
d=d[r.str.contains('WON|LOST',case=False,na=False)].reset_index(drop=True); win=d[c('Sonuç (')].str.contains('WON',case=False)
sc=d[c('Skor')].str.extract(r'(\d+)\s*-\s*(\d+)').astype(float); h,a=sc[0],sc[1]
oh=pd.to_numeric(d[c('KO Oran Ev')],errors='coerce'); oa=pd.to_numeric(d[c('KO Oran Dep')],errors='coerce')
t=pd.to_datetime(d[c('Tarih')].str.extract(r'(\d{4}-\d\d-\d\d)')[0]); A=t<='2026-09-27'
num=lambda k:pd.to_numeric(d[c(k)].str.replace('=','').str.replace('"',''),errors='coerce')
sot=num('Şut İsabetli Ev')+num('Şut İsabetli Dep'); since=num('Son Golden'); cor=num('Korner Ev')+num('Korner Dep'); red=num('Kırmızı Kart Ev')+num('Kırmızı Kart Dep'); tot=h+a; mn=num('Sinyal Dk')
def show(name,groups):
  print('==',name)
  for lab,m in groups:
    print(f'  {lab:18s} n={int(m.sum()):5d} {win[m].mean()*100:5.1f}%  A {win[m&A].mean()*100:5.1f} B {win[m&~A].mean()*100:5.1f}')
show('SoT',[('0-4',sot<=4),('5-8',(sot>=5)&(sot<=8)),('9-12',(sot>=9)&(sot<=12)),('13+',sot>=13)])
show('since last goal',[('<5',since<5),('5-15',(since>=5)&(since<15)),('15-30',(since>=15)&(since<30)),('30+',since>=30)])
show('corners',[('0-6',cor<=6),('7-10',(cor>=7)&(cor<=10)),('11+',cor>=11)])
show('red',[('0',red==0),('1+',red>=1)])
show('goals so far',[('0',tot==0),('1',tot==1),('2',tot==2),('3',tot==3),('4+',tot>=4)])
print(since.describe())
