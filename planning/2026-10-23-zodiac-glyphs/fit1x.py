# Map 2x-frame paths onto the shipped 1x PNG: per-glyph uniform scale + translation from ink bboxes.
import sys, math, json, re
sys.path.insert(0,'.'); from pngload import load
names="Pisces,Aquarius,Capricorn,Sagittarius,Scorpius,Libra,Virgo,Leo,Cancer,Gemini,Taurus,Aries".split(',')
def sampler(path, scale, mode):
    w,h,bpp,rows=load(path)
    def val(x,y):
        x*=scale; y*=scale
        if x<0 or y<0 or x>=w-1 or y>=h-1: return 0
        x0=int(x); y0=int(y); fx=x-x0; fy=y-y0
        if mode=='alphaR': g=lambda xx,yy: rows[yy][xx*4+3]*rows[yy][xx*4]/255
        else: g=lambda xx,yy: rows[yy][xx*bpp]
        return (g(x0,y0)*(1-fx)+g(x0+1,y0)*fx)*(1-fy)+(g(x0,y0+1)*(1-fx)+g(x0+1,y0+1)*fx)*fy
    return val
def mask(val, i, HALF, RES, thresh):
    N=int(2*HALF/RES); a=i*math.pi/6; bottom=3<i<9; ca,sa=math.cos(a),math.sin(a)
    img=[[0]*N for _ in range(N)]
    for r in range(N):
        fy=-HALF+(r+0.5)*RES
        for c in range(N):
            fx=-HALF+(c+0.5)*RES
            gx,gy=(-fx,-fy) if bottom else (fx,fy)
            vx,vy=gx,gy-237
            px=263+ca*vx-sa*vy; py=263+sa*vx+ca*vy
            img[r][c]=1 if val(px,py)>thresh else 0
    return img
def bbox(img, HALF, RES):
    xs=[];ys=[]
    for r,row in enumerate(img):
        for c,v in enumerate(row):
            if v: xs.append(-HALF+(c+0.5)*RES); ys.append(-HALF+(r+0.5)*RES)
    return min(xs),max(xs),min(ys),max(ys)
v2=sampler('zodiac2x.png',2,'lum'); v1=sampler('zodiac1x.png',1,'alphaR')
src=open('glyphs.js').read()
G=json.loads(re.search(r'GLYPHS\s*=\s*(\[.*?\]);\s*\n', src, re.S).group(1))
def xform(d,k,tx,ty):
    out=[]; toks=re.findall(r'[MLCQZ]|-?\d*\.?\d+', d); i=0
    while i<len(toks):
        t=toks[i]
        if t in 'MLCQZ': out.append(t); i+=1; continue
        x=float(toks[i]); y=float(toks[i+1]); i+=2
        out.append(f"{x*k+tx:.2f} {y*k+ty:.2f}")
    return ' '.join(out)
final=[]
for i,g in enumerate(G):
    m2=mask(v2,i,30,0.5,110); m1=mask(v1,i,20,0.25,100)
    b2=bbox(m2,30,0.5); b1=bbox(m1,20,0.25)
    kx=(b1[1]-b1[0])/(b2[1]-b2[0]); ky=(b1[3]-b1[2])/(b2[3]-b2[2]); k=(kx+ky)/2
    cx2=(b2[0]+b2[1])/2; cy2=(b2[2]+b2[3])/2; cx1=(b1[0]+b1[1])/2; cy1=(b1[2]+b1[3])/2
    tx=cx1-k*cx2+g.get('dx',0); ty=cy1-k*cy2+g.get('dy',0)
    fg={'ch':g['ch'],'name':g['name'],'w':round(g['w']*k,2),'d':[xform(d,k,tx,ty) for d in g['d']]}
    if 'd1x' in g: fg={'ch':g['ch'],'name':g['name'],'w':g['w1x'],'d':g['d1x']}
    if g.get('f'): fg['f']=[xform(d,k,tx,ty) for d in g['f']]
    final.append(fg)
    print(f"{i:2d} {g['name']:12s} k={k:.3f} (kx {kx:.3f} ky {ky:.3f})  shift=({tx:+.2f},{ty:+.2f})  1x bbox x[{b1[0]:.1f},{b1[1]:.1f}] y[{b1[2]:.1f},{b1[3]:.1f}]")
open('glyphs1x.js','w').write('// Final glyphs in the 1x frame (units = reference px at s = 1; origin = slot centre r=237)\nconst GLYPHS = '+json.dumps(final,ensure_ascii=False,indent=1)+';\nconst STROKE_W = 2.2;\n')
print('wrote glyphs1x.js')
