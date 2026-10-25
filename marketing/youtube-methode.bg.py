# Royalty-free background made from scratch: stadium crowd bed, cheers at key moments, light 120 BPM groove.
import numpy as np, wave
SR=44100; T=240; n=SR*T; rng=np.random.default_rng(7); t=np.arange(n)/SR
def bandnoise(N,lo,hi):
    x=rng.standard_normal(N); X=np.fft.rfft(x); f=np.fft.rfftfreq(N,1/SR)
    X[(f<lo)|(f>hi)]=0; X[f>0]/=np.sqrt(f[f>0]/lo); y=np.fft.irfft(X,N); return y/np.abs(y).max()
crowd=bandnoise(n,250,3000)*(0.6+0.4*np.sin(2*np.pi*t/7.3)*np.sin(2*np.pi*t/2.9))
out=0.10*crowd
for c in [0.3,102.4,122.4,144.4,174.2,184.4,209.2,232.4]:
    L=int(3.2*SR); s=int(c*SR); e=min(n,s+L); k=np.arange(e-s)/SR
    env=np.minimum(k/0.35,1)*np.exp(-np.maximum(k-0.6,0)/1.0)
    out[s:e]+=0.45*bandnoise(e-s,400,5000)*env
# groove
bpm=120; beat=60/bpm; music=np.zeros(n)
def add(sig,at):
    s=int(at*SR); e=min(n,s+len(sig)); music[s:e]+=sig[:e-s]
kk=np.arange(int(0.25*SR))/SR; kick=np.sin(2*np.pi*(50+70*np.exp(-kk*25))*kk)*np.exp(-kk*12)
cl=np.arange(int(0.15*SR))/SR; clap=rng.standard_normal(len(cl))*np.exp(-cl*30)*0.5
hh=np.arange(int(0.05*SR))/SR; hat=rng.standard_normal(len(hh))*np.exp(-hh*80)*0.15
prog=[261.63,196.00,220.00,174.61]  # C G Am F
nb=int(T/beat)
for b in range(nb):
    at=b*beat; add(kick*0.8,at)
    if b%2==1: add(clap,at)
    add(hat,at+beat/2)
    root=prog[(b//4)%4]; d=np.arange(int(beat*SR))/SR
    bass=np.sign(np.sin(2*np.pi*root/4*d))*0.12*np.exp(-d*3)
    chord=sum(np.sin(2*np.pi*root*r*d) for r in (1,1.25,1.5))*0.05*np.exp(-d*2)
    add(bass+chord,at)
music/=np.abs(music).max()
mix=out+0.35*music
fade=np.ones(n); fi=int(2*SR); fade[:fi]=np.linspace(0,1,fi); fade[-int(4*SR):]=np.linspace(1,0,int(4*SR))
mix=mix*fade; mix=mix/np.abs(mix).max()*0.8
st=np.stack([mix,np.roll(mix,300)],1)
w=wave.open("bg.wav","wb"); w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes((st*32767).astype(np.int16).tobytes()); w.close()
