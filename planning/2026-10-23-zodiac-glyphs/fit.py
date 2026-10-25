# Evaluate authored stroke paths (glyphs.js) against the PNG ink mask per glyph.
import sys, math, json, re
sys.path.insert(0,'.'); from pngload import load
w,h,bpp,rows=load('zodiac2x.png')
def lum(x,y):
    if x<0 or y<0 or x>=w-1 or y>=h-1: return 0
    x0=int(x); y0=int(y); fx=x-x0; fy=y-y0
    g=lambda xx,yy: rows[yy][xx*bpp]
    return (g(x0,y0)*(1-fx)+g(x0+1,y0)*fx)*(1-fy)+(g(x0,y0+1)*(1-fx)+g(x0+1,y0+1)*fx)*fy
HALF=27; RES=0.25; N=int(2*HALF/RES)
src=open('glyphs.js').read()
m=re.search(r'GLYPHS\s*=\s*(\[.*?\]);\s*\n', src, re.S); G=json.loads(m.group(1))
SW=float(re.search(r'STROKE_W\s*=\s*([\d.]+)',src).group(1))
def mask(i):
    a=i*math.pi/6; bottom=3<i<9; ca,sa=math.cos(a),math.sin(a)
    img=[[0]*N for _ in range(N)]
    for r in range(N):
        fy=-HALF+(r+0.5)*RES
        for c in range(N):
            fx=-HALF+(c+0.5)*RES
            gx,gy=(-fx,-fy) if bottom else (fx,fy)
            vx,vy=gx,gy-237
            px=263+ca*vx-sa*vy; py=263+sa*vx+ca*vy
            img[r][c]=1 if lum(px*2,py*2)>110 else 0
    return img
def flatten(d):
    toks=re.findall(r'[MLCQZ]|-?\d*\.?\d+', d); pts=[]; i=0; cur=(0,0); start=None; cmd=None
    def num():
        nonlocal i; v=float(toks[i]); i+=1; return v
    def seg_line(p):
        n=max(2,int(math.hypot(p[0]-cur[0],p[1]-cur[1])/0.2)+1)
        return [(cur[0]+(p[0]-cur[0])*t/n, cur[1]+(p[1]-cur[1])*t/n) for t in range(1,n+1)]
    while i<len(toks):
        if toks[i] in 'MLCQZ': cmd=toks[i]; i+=1
        if cmd=='M': cur=(num(),num()); start=cur; pts.append(cur); cmd='L'; continue
        if cmd=='L': p=(num(),num()); pts+=seg_line(p); cur=p
        elif cmd=='Z': pts+=seg_line(start); cur=start; cmd=None
        elif cmd=='Q':
            c1=(num(),num()); p=(num(),num())
            for t in [k/60 for k in range(1,61)]:
                pts.append(((1-t)**2*cur[0]+2*(1-t)*t*c1[0]+t*t*p[0],(1-t)**2*cur[1]+2*(1-t)*t*c1[1]+t*t*p[1]))
            cur=p
        elif cmd=='C':
            c1=(num(),num()); c2=(num(),num()); p=(num(),num())
            for t in [k/80 for k in range(1,81)]:
                u=1-t; pts.append((u**3*cur[0]+3*u*u*t*c1[0]+3*u*t*t*c2[0]+t**3*p[0], u**3*cur[1]+3*u*u*t*c1[1]+3*u*t*t*c2[1]+t**3*p[1]))
            cur=p
    return pts
sel=[int(v) for v in sys.argv[1].split(',')] if len(sys.argv)>1 and not sys.argv[1].startswith('-') else range(12)
show='-q' not in sys.argv
for i in sel:
    g=G[i]; img=mask(i)
    pts=[]
    for d in g['d']+g.get('f',[]): pts+=flatten(d)
    # path raster: cells within SW/2 of any sample point
    cover=[[0]*N for _ in range(N)]
    rad=g.get('w',SW)/2
    for (x,y) in pts:
        c0=int((x-rad+HALF)/RES); c1=int((x+rad+HALF)/RES); r0=int((y-rad+HALF)/RES); r1=int((y+rad+HALF)/RES)
        for r in range(max(0,r0),min(N,r1+1)):
            fy=-HALF+(r+0.5)*RES
            for c in range(max(0,c0),min(N,c1+1)):
                fx=-HALF+(c+0.5)*RES
                if (fx-x)**2+(fy-y)**2<=rad*rad: cover[r][c]=1
    ink=sum(map(sum,img)); cov=sum(map(sum,cover))
    both=sum(1 for r in range(N) for c in range(N) if img[r][c] and cover[r][c])
    print(f"{i:2d} {g['name']:12s} ink={ink:5d} path={cov:5d}  recall(ink covered)={both/max(1,ink):.3f}  precision(path on ink)={both/max(1,cov):.3f}")
    if show:
        print('      '+''.join(f"{x:<4}" for x in range(-HALF,HALF,2)))
        for R in range(0,N,4):
            line=''
            for C in range(0,N,2):
                cells=[(R+dr,C+dc) for dr in range(4) for dc in range(2)]
                a=any(img[r][c] for r,c in cells); b=any(cover[r][c] for r,c in cells)
                line+= '#' if (a and b) else ('+' if b else ('.' if a else ' '))
            print(f"{-HALF+R*RES:5.0f} "+line)
