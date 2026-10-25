import sys, math
sys.path.insert(0,'.'); from pngload import load
w,h,bpp,rows=load('zodiac2x.png')   # RGB 1052
def lum(x,y):
    if x<0 or y<0 or x>=w-1 or y>=h-1: return 0
    x0=int(x); y0=int(y); fx=x-x0; fy=y-y0
    def g(xx,yy): return rows[yy][xx*bpp]
    return (g(x0,y0)*(1-fx)+g(x0+1,y0)*fx)*(1-fy)+(g(x0,y0+1)*(1-fx)+g(x0+1,y0+1)*fx)*fy
names="Pisces,Aquarius,Capricorn,Sagittarius,Scorpius,Libra,Virgo,Leo,Cancer,Gemini,Taurus,Aries".split(',')
HALF=int(sys.argv[2]) if len(sys.argv)>2 else 17; RES=0.25; N=int(2*HALF/RES)
sel=[int(v) for v in sys.argv[1].split(",")]
for i in sel:
    a=i*math.pI if False else i*math.pi/6; bottom=3<i<9
    ca,sa=math.cos(a),math.sin(a)
    img=[[0]*N for _ in range(N)]
    for r in range(N):
        fy=-HALF+(r+0.5)*RES
        for c in range(N):
            fx=-HALF+(c+0.5)*RES
            gx,gy=(-fx,-fy) if bottom else (fx,fy)
            vx,vy=gx,gy-237
            px=263+ca*vx-sa*vy; py=263+sa*vx+ca*vy
            img[r][c]=1 if lum(px*2,py*2)>110 else 0
    # Zhang-Suen thinning
    sk=[row[:] for row in img]
    def nb(r,c):
        return [sk[r-1][c],sk[r-1][c+1],sk[r][c+1],sk[r+1][c+1],sk[r+1][c],sk[r+1][c-1],sk[r][c-1],sk[r-1][c-1]]
    changed=True
    while changed:
        changed=False
        for step in (0,1):
            rem=[]
            for r in range(1,N-1):
                for c in range(1,N-1):
                    if not sk[r][c]: continue
                    P=nb(r,c); B=sum(P)
                    if B<2 or B>6: continue
                    A=sum(1 for k in range(8) if P[k]==0 and P[(k+1)%8]==1)
                    if A!=1: continue
                    if step==0 and (P[0]*P[2]*P[4] or P[2]*P[4]*P[6]): continue
                    if step==1 and (P[0]*P[2]*P[6] or P[0]*P[4]*P[6]): continue
                    rem.append((r,c))
            for r,c in rem: sk[r][c]=0
            if rem: changed=True
    if '-w' in sys.argv:
        ink=sum(map(sum,img))*RES*RES
        # skeleton length: count 4-neighbour steps as RES, diagonal as RES*1.414 (approx via pixel count*1.2)
        skn=sum(map(sum,sk))
        print(f"{i:2d} {names[i]:12s} ink area {ink:7.1f}  skeleton px {skn:5d}  mean width ≈ {ink/(skn*RES*1.15):.2f}")
        continue
    if '-xy' in sys.argv:
        print(f"\n=== {i} {names[i]} skeleton run centres (x per 1-unit row) ===")
        for R in range(0,N,4):
            y=-HALF+R*RES+0.5
            xs=set()
            for r in range(R,R+4):
                run=[]
                for c in range(N+1):
                    on = c<N and sk[r][c]
                    if on: run.append(c)
                    elif run: xs.add(round(-HALF+(sum(run)/len(run)+0.5)*RES,1)); run=[]
            # merge near-duplicates
            xs=sorted(xs); out=[]
            for x in xs:
                if out and abs(x-out[-1][-1])<=0.6: out[-1].append(x)
                else: out.append([x])
            if out: print(f"  y={y:6.1f}: "+'  '.join(f"{sum(g)/len(g):6.1f}" for g in out))
        continue
    # print at 0.5 unit/col, 1 unit/row
    print(f"\n=== {i} {names[i]}  (cols: x unit, rows: y unit; '.' ink, '#' skeleton) ===")
    hdr1=''.join((f"{x:>4}" if x%2==0 else '    ')[0:4] for x in range(-HALF,HALF,2))
    print('      '+''.join(f"{x:<4}" for x in range(-HALF,HALF,2)))
    for R in range(0,N,4):
        y=-HALF+R*RES
        line=''
        for C in range(0,N,2):
            cells=[(R+dr,C+dc) for dr in range(4) for dc in range(2)]
            if any(sk[r][c] for r,c in cells): ch='#'
            elif any(img[r][c] for r,c in cells): ch='.'
            else: ch=' '
            line+=ch
        print(f"{y:5.0f} "+line)
