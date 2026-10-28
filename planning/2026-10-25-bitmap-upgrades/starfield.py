import json, math, random
from math import erf, sqrt
from PIL import Image, ImageDraw
S='/private/tmp/claude-501/-Users-spucci-chronometer-web/15b8caba-e175-4fb6-9eba-1b62fb222c5a/scratchpad'
STARS=json.load(open(f'{S}/stars.json'))            # measured at the image's native 1536x2048
IMG_W,IMG_H=1536,2048; DENSITY=len(STARS)/(IMG_W*IMG_H)  # stars per image px²

def mulberry32(seed):
    a=seed&0xffffffff
    def rnd():
        nonlocal a
        a=(a+0x6D2B79F5)&0xffffffff; t=a
        t=((t ^ (t>>15))*(t|1))&0xffffffff
        t^=(t+(((t ^ (t>>7))*(t|61))&0xffffffff))&0xffffffff
        return ((t ^ (t>>14))&0xffffffff)/4294967296
    return rnd

def cover_scale(W,H):
    # iOS/today: portrait image rotated for landscape; device px per image px
    tw,th=(H,W) if W>H else (W,H)
    return max(tw/IMG_W, th/IMG_H)

SKY=8192                      # virtual sky, device px, centred on the window: bigger windows reveal more of it
REF_K=0.625                   # cover scale at 1280x800: today's star size and density in device px
DENS=DENSITY/(REF_K*REF_K)    # stars per device px² (≈ 290 per megapixel)

def render_sky(W,H,seed=20261025):
    """Rule S: constant star size, count ∝ area, stable positions (fixed virtual sky)."""
    rnd=mulberry32(seed); n_total=round(DENS*SKY*SKY); buf=[[0.0]*W for _ in range(H)]; R=[[0.0]*W for _ in range(H)]; B=[[0.0]*W for _ in range(H)]
    ox,oy=W/2-SKY/2,H/2-SKY/2; drawn=0
    for i in range(n_total):
        u=rnd(); v=rnd(); j=int(rnd()*len(STARS))
        x=u*SKY+ox; y=v*SKY+oy
        if x<-8 or y<-8 or x>=W+8 or y>=H+8: continue
        st=STARS[j]; peak=st['peak']; rl=st['rgb'][0]/max(1,peak); bl=st['rgb'][2]/max(1,peak)
        sig=max(st['sigma']*REF_K,0.35); rad=int(math.ceil(4*sig)); flux=st['flux']*REF_K*REF_K; s2=sig*sqrt(2); drawn+=1
        x0=max(0,int(x)-rad); x1=min(W,int(x)+rad+1); y0=max(0,int(y)-rad); y1=min(H,int(y)+rad+1)
        fx=[0.5*(erf((xx+1-x)/s2)-erf((xx-x)/s2)) for xx in range(x0,x1)]
        fy=[0.5*(erf((yy+1-y)/s2)-erf((yy-y)/s2)) for yy in range(y0,y1)]
        for jj,yy in enumerate(range(y0,y1)):
            if fy[jj]<1e-4: continue
            for ii,xx in enumerate(range(x0,x1)):
                L=flux*fx[ii]*fy[jj]
                if L<0.3: continue
                buf[yy][xx]+=L; R[yy][xx]+=L*rl; B[yy][xx]+=L*bl
    out=Image.new('RGB',(W,H)); op=out.load()
    for yy in range(H):
        for xx in range(W):
            L=buf[yy][xx]
            if L<=0: continue
            r=R[yy][xx]; b=B[yy][xx]; g=max(0,(L-0.299*r-0.114*b)/0.587)
            op[xx,yy]=(min(255,int(r)),min(255,int(g)),min(255,int(b)))
    return out,drawn,n_total

def render(W,H,rule='A',seed=20261025):
    k=cover_scale(W,H); n=round(DENSITY*W*H/(k*k)); rnd=mulberry32(seed)
    buf=[[0.0]*W for _ in range(H)]; R=[[0.0]*W for _ in range(H)]; B=[[0.0]*W for _ in range(H)]
    for i in range(n):
        st=STARS[int(rnd()*len(STARS))]; x=rnd()*W; y=rnd()*H
        peak=st['peak']; rl=st['rgb'][0]/max(1,peak); bl=st['rgb'][2]/max(1,peak)
        if rule=='A': sig=st['sigma']*k                        # today's proportions (scaled with the viewport)
        else:         sig=st['sigma']*math.sqrt(k*0.625)       # identical at 1280x800; grows only as √ at 4K
        sig=max(sig,0.35); rad=int(math.ceil(4*sig))
        # pixel-integrated Gaussian (separable erf) so the star's flux is exact at any width;
        # flux scales with the cover area (k²) exactly as the scaled image's does
        flux=st['flux']*k*k; s2=sig*sqrt(2)
        x0=max(0,int(x)-rad); x1=min(W,int(x)+rad+1); y0=max(0,int(y)-rad); y1=min(H,int(y)+rad+1)
        fx=[0.5*(erf((xx+1-x)/s2)-erf((xx-x)/s2)) for xx in range(x0,x1)]
        fy=[0.5*(erf((yy+1-y)/s2)-erf((yy-y)/s2)) for yy in range(y0,y1)]
        for j,yy in enumerate(range(y0,y1)):
            if fy[j]<1e-4: continue
            for i,xx in enumerate(range(x0,x1)):
                L=flux*fx[i]*fy[j]
                if L<0.3: continue
                buf[yy][xx]+=L; R[yy][xx]+=L*rl; B[yy][xx]+=L*bl
    out=Image.new('RGB',(W,H)); op=out.load()
    for yy in range(H):
        for xx in range(W):
            L=buf[yy][xx]
            if L<=0: continue
            r=R[yy][xx]; b=B[yy][xx]; g=max(0,(L-0.299*r-0.114*b)/0.587)
            op[xx,yy]=(min(255,int(r)),min(255,int(g)),min(255,int(b)))
    return out,n,k

def image_cover(W,H):
    im=Image.open('/Users/spucci/chronometer-web/.observatory-ref/Resources/background@2x.png').convert('RGB')
    if W>H: im=im.rotate(-90,expand=True)
    k=max(W/im.size[0],H/im.size[1]); dw,dh=int(round(im.size[0]*k)),int(round(im.size[1]*k))
    im=im.resize((dw,dh),Image.BILINEAR); ox,oy=(dw-W)//2,(dh-H)//2
    return im.crop((ox,oy,ox+W,oy+H))

if __name__=='__main__':
    # Rule S sheet: 1280x800 full · 4K crop 1:1 · full 4K at 1/3, image vs fixed sky
    a=image_cover(1280,800); b,n,nt=render_sky(1280,800); print('1280x800: stars in view',n,'of',nt,'in the virtual sky')
    row1=Image.new('RGB',(1280*2+30,800+30),(40,40,40)); row1.paste(a,(10,20)); row1.paste(b,(1280+20,20))
    ImageDraw.Draw(row1).text((10,4),'1280x800 full frame — left: background@2x.png cover-scaled (today) · right: fixed sky (rule S)',fill=(220,220,220))
    W,H=3840,2160; box=(200,150,1200,750)
    ia=image_cover(W,H); ps,n,_=render_sky(W,H); print('4K: stars in view',n)
    row2=Image.new('RGB',(1000*2+30,600+30),(40,40,40))
    for i,(lab,im) in enumerate((('image upscaled ×1.875 (today)',ia.crop(box)),('fixed sky: same pixel size, count ∝ area',ps.crop(box)))):
        row2.paste(im,(10+i*1010,20)); ImageDraw.Draw(row2).text((10+i*1010,4),'4K crop 1:1 — '+lab,fill=(220,220,220))
    i4=ia.resize((1280,720),Image.BOX); a4=ps.resize((1280,720),Image.BOX)
    row3=Image.new('RGB',(1280*2+30,720+30),(40,40,40)); row3.paste(i4,(10,20)); row3.paste(a4,(1280+20,20))
    ImageDraw.Draw(row3).text((10,4),'3840x2160 full frame at 1/3 — left: image (today) · right: fixed sky (rule S)',fill=(220,220,220))
    out=Image.new('RGB',(max(row1.size[0],row2.size[0],row3.size[0]),row1.size[1]+row2.size[1]+row3.size[1]+20),(40,40,40)); out.paste(row1,(0,0)); out.paste(row2,(0,row1.size[1]+10)); out.paste(row3,(0,row1.size[1]+row2.size[1]+20))
    out.save(f'{S}/starfield-sheet-S.png'); print('sheet',out.size); ps.save(f'{S}/star4k-S.png'); b.save(f'{S}/star1280-S.png')
