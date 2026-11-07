#!/usr/bin/env python3
"""Daten der Woche 07.11.: noch ein Tor nach ~60. Minute nach Ballbesitz-Unterschied (eindeutige Spiele, früheste Szene 55.–65.)."""
import pandas as pd, glob
fs=sorted(glob.glob("data/inplayflux_sinyaller_*.csv"))
d=pd.concat([pd.read_csv(f,encoding="utf-8-sig",dtype=str) for f in fs]).reset_index(drop=True)
c=lambda s:[x for x in d.columns if x.startswith(s)][0]
d["t"]=d[c("Tarih")].str.extract(r"(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)")[0]
d=d.drop_duplicates(["t",c("Strateji"),c("Maç"),c("Sinyal Dk")])
R=c("Sonuç (Result)"); d=d[d[R].str.contains("✅|❌",na=False)&~d[c("Hedef")].str.contains("HT",na=False)].copy()
d["won"]=d[R].str.contains("✅"); d["min"]=pd.to_numeric(d[c("Sinyal Dk")],errors="coerce")
d=d[(d["min"]>=55)&(d["min"]<=65)]
d["k"]=d.t.str[:10]+d[c("Maç")]; d=d.sort_values("t").drop_duplicates("k")
f=lambda col:pd.to_numeric(d[c(col)],errors="coerce")
d["pos"]=(f("Possession Ev")-f("Possession Dep")).abs()
d["da"]=f("Tehlikeli Atak Ev")+f("Tehlikeli Atak Dep")
d["sh"]=f("Şut Toplam Ev")+f("Şut Toplam Dep")
split=d.t.quantile(0.5) if False else sorted(d.t)[len(d)//2]
print(len(d), d.t.min(), d.t.max(), "split", split)
def grp(name,mask):
  x=d[mask]; a=x[x.t<split]; b=x[x.t>=split]
  print(f"{name:25s} n={len(x):5d} {x.won.mean()*100:5.1f}% | {a.won.mean()*100:5.1f} ({len(a)}) / {b.won.mean()*100:5.1f} ({len(b)})")
for lo,hi in [(0,10),(10,20),(20,30),(30,101)]: grp(f"Ballbesitz-Diff {lo}-{hi}",(d.pos>=lo)&(d.pos<hi))
q=d.da.quantile([.25,.5,.75]).tolist(); print("DA quart",q)
for lo,hi in [(0,q[0]),(q[0],q[1]),(q[1],q[2]),(q[2],1e9)]: grp(f"Gef. Angriffe {lo:.0f}-{hi:.0f}",(d.da>=lo)&(d.da<hi))
q=d.sh.quantile([.25,.5,.75]).tolist(); print("Shots quart",q)
for lo,hi in [(0,q[0]),(q[0],q[1]),(q[1],q[2]),(q[2],1e9)]: grp(f"Schüsse {lo:.0f}-{hi:.0f}",(d.sh>=lo)&(d.sh<hi))
print("pos==0:", (d.pos==0).sum(), d.pos.isna().sum())
d=d[(d.pos>0)]
for lo,hi in [(1,10),(10,20),(20,30),(30,101)]: grp(f"ohne 50:50 {lo}-{hi}",(d.pos>=lo)&(d.pos<hi))
