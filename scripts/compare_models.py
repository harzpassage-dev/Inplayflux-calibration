# Vergleicht zwei Kalibrierungen (CONFIDENCE_MODELS aus zwei Ständen von worker/src/index.js) auf denselben Karten.
#   python3 scripts/compare_models.py <git-commit-alt> <ab "YYYY-MM-DD hh:mm"> [weitere CSV ...]
# Beispiel 29.10.: python3 scripts/compare_models.py 46ee435^ "2026-10-26 17:25" /pfad/export.csv
# Fair ist nur der Zeitraum nach dem jüngeren Lern-Ende (für beide Modelle ungesehen). Jedes Spiel+Linie zählt einmal.
import sys,re,glob,json,math,subprocess; sys.path.insert(0,'scripts')
from goal_drivers import load
def models(src):
    a=src.index('const CONFIDENCE_MODELS = {'); blk=src[a:src.index('\n};',a)]; out={}
    for line,body in re.findall(r'\n  ([\d.]+): \{(.*?)\n  \}',blk,re.S):
        g=lambda k: json.loads(re.search(k+r': (\[.*?\]|[\d.\-]+)',body).group(1))
        out[float(line)]=dict(mean=g('mean'),std=g('std'),coef=g('coef'),b=g('intercept'),t=g('threshold'))
    return out
OLD=models(subprocess.check_output(['git','show',sys.argv[1]+':worker/src/index.js'],text=True))
NEW=models(open('worker/src/index.js').read())
df=load(sorted(glob.glob('data/*.csv'))+sys.argv[3:]).drop_duplicates(subset=['Tarih','Maç','Strateji','Sinyal Dk'])
f=lambda c: df[c].fillna(0)
df['sot']=f('Şut İsabetli Ev')+f('Şut İsabetli Dep'); df['line']=df['Toplam Gol Sinyal Anı']+0.5
def ok(M,r):
    m=M.get(r.line)
    x=[r['Sinyal Dk'],r.sot,r['Radar X Score'],r['MÖ Gol Baremi']]
    z=m['b']+sum(c*(v-mu)/sd for c,v,mu,sd in zip(m['coef'],x,m['mean'],m['std']))
    return 1/(1+math.exp(-z))>=m['t']
d=df[(df.Tarih>sys.argv[2])&df.line.isin([0.5,2.5,3.5])].copy()
d['old']=d.apply(lambda r:ok(OLD,r),axis=1); d['new']=d.apply(lambda r:ok(NEW,r),axis=1)
d['k']=d.Tarih.str[:10]+d['Maç']+d.line.astype(str)
print('Karten ab',sys.argv[2],'bis',d.Tarih.max())
for ln in [0.5,2.5,3.5,'alle']:
    x=d if ln=='alle' else d[d.line==ln]
    o=x[x.old].drop_duplicates('k'); n=x[x.new].drop_duplicates('k'); r=x.drop_duplicates('k')
    print(f"O{ln}: alt {o.won.mean()*100:5.1f}% (n{len(o)})  neu {n.won.mean()*100:5.1f}% (n{len(n)})  alle Karten {r.won.mean()*100:5.1f}% (n{len(r)})")
