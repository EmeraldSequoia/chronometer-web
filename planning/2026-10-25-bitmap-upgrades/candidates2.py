import math, sys
from collections import deque
from PIL import Image, ImageDraw, ImageFilter, ImageEnhance
sys.path.insert(0, '/private/tmp/claude-501/-Users-spucci-chronometer-web/15b8caba-e175-4fb6-9eba-1b62fb222c5a/scratchpad')
from composite import disc_geometry, circular_cutout, place, S, D, O
R='/Users/spucci/chronometer-web/.observatory-ref/Resources'; A='/Users/spucci/chronometer-web/src/shared/assets/planets'
O2=f'{S}/out2'
import os; os.makedirs(O2, exist_ok=True)

def mean_rgb(im):
    im=im.convert('RGBA'); px=im.load(); W,H=im.size; n=0; acc=[0,0,0]
    for y in range(H):
        for x in range(W):
            r,g,b,a=px[x,y]
            if a>200: n+=1; acc[0]+=r; acc[1]+=g; acc[2]+=b
    return tuple(v/n for v in acc), n

def venus():
    im=Image.open(f'{D}/venus-pvo/pvo.jpg').convert('RGB'); W,H=im.size
    # Scanned print: the background is noisy grey (~25). Smooth, threshold at 60, and fit the circle
    # from the sharp left/top/bottom edges (the right limb is a soft terminator, possibly clipped).
    g=im.convert('L').filter(ImageFilter.BoxBlur(3)); gp=g.load(); T=60
    xs=[x for x in range(W) if any(gp[x,y]>T for y in range(0,H,2))]
    ys=[y for y in range(H) if any(gp[x,y]>T for x in range(0,W,2))]
    x0=min(xs); y0=min(ys); y1=max(ys)+1; r=(y1-y0)/2; cy=(y0+y1)/2; cx=x0+r
    print(f'pvo: bbox x {x0}..{max(xs)}, y {y0}..{y1}; circle r {r:.0f} centre ({cx:.0f},{cy:.0f}) image {W}x{H}; right limb beyond frame by {cx+r-W:.0f} px')
    # Pad and fill the clipped right sliver: replicate the frame-edge pixel along the row, fading to black
    # over the missing width (the terminator already darkens that limb).
    PAD=80; big=Image.new('RGB',(W+2*PAD,H+2*PAD),(0,0,0)); big.paste(im,(PAD,PAD)); bp=big.load(); ip=im.load()
    cx+=PAD; cy+=PAD
    for y in range(H):
        yy=y+PAD; dy=yy-cy
        if abs(dy)>=r: continue
        xlim=cx+math.sqrt(r*r-dy*dy)        # true limb on this row
        miss=xlim-(W-1+PAD)
        if miss<=0: continue
        c=ip[W-1,y]
        for xx in range(W+PAD, min(W+2*PAD-1, int(math.ceil(xlim))+1)):
            k=max(0.0, 1-(xx-(W-1+PAD))/miss)**0.5
            bp[xx,yy]=(int(c[0]*k),int(c[1]*k),int(c[2]*k))
    asis=circular_cutout(big,cx,cy,r*0.985,96)
    place(asis,300,136).save(f'{O2}/venus-pvo-asis300.png')
    tgt,_=mean_rgb(Image.open(f'{A}/venus300.png')); Lt=0.299*tgt[0]+0.587*tgt[1]+0.114*tgt[2]
    old,_=mean_rgb(Image.open(f'{R}/venus.png'))
    print('current venus master mean', tuple(round(v) for v in tgt), 'old iOS icon mean', tuple(round(v) for v in old))
    lum=asis.convert('L'); lp=lum.load(); ap=asis.split()[3].load(); n=0; acc=0
    for y in range(96):
        for x in range(96):
            if ap[x,y]>200: n+=1; acc+=lp[x,y]
    Lm=acc/n; C=0.6   # contrast factor on the luminance about its mean
    Lold=0.299*old[0]+0.587*old[1]+0.114*old[2]
    for tag,tint,Lgoal in (('retoned', old, Lold), ('neutral', tgt, Lt)):   # cream at the old icon's brightness, neutral at the Mariner master's
        Lt2=0.299*tint[0]+0.587*tint[1]+0.114*tint[2]
        out=Image.new('RGBA',(96,96),(0,0,0,0)); op=out.load()
        for y in range(96):
            for x in range(96):
                L=Lm+(lp[x,y]-Lm)*C; k=L/Lt2
                op[x,y]=(min(255,int(tint[0]*k)),min(255,int(tint[1]*k)),min(255,int(tint[2]*k)),ap[x,y])
        cur,_=mean_rgb(out); Lc=0.299*cur[0]+0.587*cur[1]+0.114*cur[2]; gain=Lgoal/Lc
        out=Image.merge('RGBA',[c.point(lambda v: min(255,int(v*gain))) for c in out.split()[:3]]+[out.split()[3]])
        place(out,300,136).save(f'{O2}/venus-pvo-{tag}300.png'); print(f'{tag}: Lm {Lm:.0f}, gain {gain:.2f}, mean', tuple(round(v) for v in mean_rgb(out)[0]))

def largest_component(mask):
    """mask: L image (0/255). Keep the largest 8-connected blob (on a /4 downscale), returned at full size."""
    k=4; small=mask.resize((mask.size[0]//k, mask.size[1]//k), Image.BOX); sp=small.load(); W,H=small.size
    seen=[[False]*H for _ in range(W)]; best=[]
    for sx in range(W):
        for sy in range(H):
            if seen[sx][sy] or sp[sx,sy]<32: continue
            q=deque([(sx,sy)]); seen[sx][sy]=True; comp=[]
            while q:
                x,y=q.popleft(); comp.append((x,y))
                for dx in (-1,0,1):
                    for dy in (-1,0,1):
                        nx,ny=x+dx,y+dy
                        if 0<=nx<W and 0<=ny<H and not seen[nx][ny] and sp[nx,ny]>=32: seen[nx][ny]=True; q.append((nx,ny))
            if len(comp)>len(best): best=comp
    keep=Image.new('L',(W,H),0); kp=keep.load()
    for x,y in best: kp[x,y]=255
    keep=keep.filter(ImageFilter.MaxFilter(3)).resize(mask.size, Image.BILINEAR)
    return Image.eval(keep, lambda v: 255 if v>127 else 0)

def saturn(src, tag, lo, hi):
    im=Image.open(src).convert('RGB'); W,H=im.size
    g=im.convert('L')
    bg=sorted(g.getdata())[int(W*H*0.3)]; print(f'{tag}: {W}x{H}, 30th-percentile luminance (background) {bg}')
    mask=g.point(lambda v: 255 if v>hi else 0); mask=largest_component(mask)
    # principal axis of the ring system → rotate so the rings run horizontally with the near side at the bottom
    mp=mask.load(); n=0; sx=sy=sxx=syy=sxy=0.0
    for y in range(0,H,2):
        for x in range(0,W,2):
            if mp[x,y]: n+=1; sx+=x; sy+=y; sxx+=x*x; syy+=y*y; sxy+=x*y
    mx,my=sx/n,sy/n; cxx=sxx/n-mx*mx; cyy=syy/n-my*my; cxy=sxy/n-mx*my
    theta=0.5*math.atan2(2*cxy, cxx-cyy)      # radians, image coords (y down): angle of the major axis below the +x axis
    deg=math.degrees(theta); print(f'{tag}: major axis {deg:.1f} deg (y-down), centroid ({mx:.0f},{my:.0f})')
    # PIL rotates counter-clockwise on screen; a major axis tilted "down-right" (theta>0 in y-down coords)
    # needs a CCW rotation by theta to come level, keeping the lower-right (near) ring end on the right.
    rot=im.rotate(deg, resample=Image.BICUBIC, expand=True, fillcolor=(0,0,0))
    mrot=mask.rotate(deg, resample=Image.BILINEAR, expand=True, fillcolor=0)
    bb=mrot.getbbox(); sub=rot.crop(bb); msub=mrot.crop(bb); sw,sh=sub.size
    k=292/sw; ss=4; big=sub.resize((int(sw*k*ss),int(sh*k*ss)),Image.LANCZOS)
    Lk=big.convert('L').point(lambda v: 0 if v<lo else (255 if v>hi else int((v-lo)*255/(hi-lo)))).filter(ImageFilter.MaxFilter(3))
    comp=msub.resize(big.size, Image.BILINEAR).filter(ImageFilter.MaxFilter(9))
    alpha=Image.eval(Image.merge('RGB',(Lk,comp,comp)).convert('L'), lambda v: v)   # placeholder
    # alpha = key AND largest-component mask (drops moons and seams)
    alpha=Image.composite(Lk, Image.new('L',big.size,0), comp.point(lambda v: 255 if v>127 else 0))
    # Voyager's filter misregistration leaves red/orange fringes at the ring edges: desaturate the
    # outermost band (within ~2 px of the alpha edge at master scale) toward its luminance.
    inner=alpha.filter(ImageFilter.MinFilter(2*ss*2+1))
    rgb=big.convert('RGB'); grey=ImageEnhance.Color(rgb).enhance(0.25)
    rgb=Image.composite(rgb, grey, inner)
    out=rgb.convert('RGBA'); out.putalpha(alpha); sp=out.resize((int(sw*k),int(sh*k)),Image.LANCZOS)
    bh=max(136, int(math.ceil(sp.size[1]/8.0))*8)
    place(sp,300,bh).save(f'{O2}/saturn-{tag}300.png'); print(f'{tag}: ring span {sw}x{sh} → {sp.size}, box 300x{bh}')

def sheet():
    s4=2.46; BG=(32,32,32,255); pad=10
    rows=[('Venus: old iOS icon', Image.open(f'{R}/venus.png').convert('RGBA'), 'old'),
          ('Venus: current master (Mariner 10)', Image.open(f'{A}/venus300.png').convert('RGBA'), 'new'),
          ('Venus: Pioneer Venus Orbiter 1979, as-is', Image.open(f'{O2}/venus-pvo-asis300.png'), 'new'),
          ('Venus: Pioneer Venus Orbiter 1979, retoned cream (old icon tint)', Image.open(f'{O2}/venus-pvo-retoned300.png'), 'new'),
          ('Venus: Pioneer Venus Orbiter 1979, retoned neutral (Mariner tint)', Image.open(f'{O2}/venus-pvo-neutral300.png'), 'new'),
          ('Saturn: old iOS icon', Image.open(f'{R}/saturn.png').convert('RGBA'), 'old'),
          ('Saturn: current master (Cassini 2016)', Image.open(f'{A}/saturn300.png').convert('RGBA'), 'new'),
          ('Saturn: Voyager 1, 1980 (PIA02225)', Image.open(f'{O2}/saturn-v1-1980300.png'), 'new'),
          ('Saturn: Voyager 2, 1981 (PIA01364)', Image.open(f'{O2}/saturn-v2-1981300.png'), 'new')]
    cells=[]
    for label,im,kind in rows:
        if kind=='old': w,h=im.size; r1=im.resize((w,h),Image.BILINEAR); r4=im.resize((int(round(w*s4)),int(round(h*s4))),Image.BILINEAR); m=None
        else: w,h=im.size[0]//4,im.size[1]//4; r1=im.resize((w,h),Image.LANCZOS); r4=im.resize((int(round(w*s4)),int(round(h*s4))),Image.LANCZOS); m=im
        cells.append((label,r1,r4,m))
    c1=max(c[1].size[0] for c in cells); c4=max(c[2].size[0] for c in cells); cm=300
    rowh=[max(c[2].size[1], c[3].size[1] if c[3] else 0)+pad+16 for c in cells]
    Wt=pad*4+c1+c4+cm; Ht=sum(rowh)+pad+24
    out=Image.new('RGBA',(Wt,Ht),BG); d=ImageDraw.Draw(out)
    d.text((pad,6),'s=1 (1280x800) | 4K draw size (x2.46) | master 1:1', fill=(200,200,200,255))
    y=pad+24
    for (label,r1,r4,m),rh in zip(cells,rowh):
        d.text((pad,y),label,fill=(150,200,255,255)); yy=y+16; x=pad
        out.alpha_composite(r1,(x,yy)); x+=c1+pad; out.alpha_composite(r4,(x,yy)); x+=c4+pad
        if m: out.alpha_composite(m,(x,yy))
        y+=rh
    out.convert('RGB').save(f'{S}/contact-fulldisc.png'); print('sheet', out.size)

if __name__=='__main__':
    steps=sys.argv[1:] or ['venus','saturn1','saturn2','sheet']
    if 'venus' in steps: venus()
    if 'saturn1' in steps: saturn(f'{D}/saturn-v1/PIA02225.tif','v1-1980',10,30)
    if 'saturn2' in steps: saturn(f'{D}/saturn-v2/PIA01364.tif','v2-1981',10,30)
    if 'sheet' in steps: sheet()
    raise SystemExit
    saturn(f'{D}/saturn-v1/PIA02225.tif','v1-1980',10,30)
    saturn(f'{D}/saturn-v2/PIA01364.tif','v2-1981',10,30)
    sheet()
