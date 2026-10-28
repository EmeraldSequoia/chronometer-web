import json, math, collections
from PIL import Image
im=Image.open('/Users/spucci/chronometer-web/.observatory-ref/Resources/background@2x.png').convert('RGB'); W,H=im.size; px=im.load()
lum=[[0.299*px[x,y][0]+0.587*px[x,y][1]+0.114*px[x,y][2] for x in range(W)] for y in range(H)]
seen=[[False]*W for _ in range(H)]; stars=[]
TH=12
for y in range(H):
    for x in range(W):
        if lum[y][x]>TH and not seen[y][x]:
            stack=[(x,y)]; seen[y][x]=True; pts=[]
            while stack:
                cx,cy=stack.pop(); pts.append((cx,cy))
                for dx in (-1,0,1):
                    for dy in (-1,0,1):
                        nx,ny=cx+dx,cy+dy
                        if 0<=nx<W and 0<=ny<H and not seen[ny][nx] and lum[ny][nx]>TH:
                            seen[ny][nx]=True; stack.append((nx,ny))
            if len(pts)<2: continue
            # luminance-weighted moments → sigma; peak; tint at peak
            tot=sum(lum[py][px_] for px_,py in pts); mx=sum(px_*lum[py][px_] for px_,py in pts)/tot; my=sum(py*lum[py][px_] for px_,py in pts)/tot
            var=sum(((px_-mx)**2+(py-my)**2)*lum[py][px_] for px_,py in pts)/tot; sigma=math.sqrt(var/2)
            pk=max(pts,key=lambda p: lum[p[1]][p[0]]); peak=lum[pk[1]][pk[0]]; r,g,b=px[pk]
            stars.append({'x':round(mx,1),'y':round(my,1),'peak':round(peak),'sigma':round(sigma,2),'flux':round(tot),'rgb':[r,g,b],'n':len(pts)})
print('stars',len(stars))
sig=sorted(s['sigma'] for s in stars); pk=sorted(s['peak'] for s in stars); fl=sorted(s['flux'] for s in stars)
q=lambda a: [round(a[int(len(a)*f)],2) for f in (0.05,0.25,0.5,0.75,0.95)]
print('sigma quantiles 5/25/50/75/95:',q(sig)); print('peak quantiles:',q(pk)); print('flux quantiles:',q(fl))
# tint relative to luminance at peak: R/L, B/L
rl=sorted(s['rgb'][0]/max(1,s['peak']) for s in stars); bl=sorted(s['rgb'][2]/max(1,s['peak']) for s in stars)
print('R/L quantiles:',q(rl)); print('B/L quantiles:',q(bl))
# correlation sigma vs peak
import statistics
big=[s for s in stars if s['peak']>150]; small=[s for s in stars if s['peak']<60]
print('sigma mean: bright stars',round(statistics.mean(s['sigma'] for s in big),2),' faint stars',round(statistics.mean(s['sigma'] for s in small),2))
json.dump(stars,open('stars.json','w'))
