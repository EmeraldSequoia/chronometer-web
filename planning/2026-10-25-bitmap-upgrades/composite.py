import math, sys
from PIL import Image, ImageDraw, ImageFilter, ImageEnhance
S='/private/tmp/claude-501/-Users-spucci-chronometer-web/15b8caba-e175-4fb6-9eba-1b62fb222c5a/scratchpad'
D=f'{S}/dl'; O=f'{S}/out'

def disc_geometry(im, thresh=24, crop=None):
    """Centre/radius of the bright disc on black: bbox of pixels above thresh (on a downscaled copy)."""
    g=im.convert('L')
    if crop: g=g.crop(crop)
    k=max(1, g.size[0]//1200); small=g.resize((g.size[0]//k, g.size[1]//k), Image.BOX)
    px=small.load(); W,H=small.size; xs=[];ys=[]
    for y in range(H):
        for x in range(W):
            if px[x,y]>thresh: xs.append(x); ys.append(y)
    x0,x1,y0,y1=min(xs)*k,(max(xs)+1)*k,min(ys)*k,(max(ys)+1)*k
    ox,oy=(crop[0],crop[1]) if crop else (0,0)
    return ((x0+x1)/2+ox,(y0+y1)/2+oy, max(x1-x0,y1-y0)/2)

def circular_cutout(im, cx, cy, r, out_d, feather=1.0, limb=0.0):
    """Cut the disc (cx,cy,r) out of im, scale to out_d px diameter, antialiased circular alpha."""
    box=(int(cx-r-2), int(cy-r-2), int(cx+r+2), int(cy+r+2))
    sub=im.convert('RGB').crop(box)
    ss=4; size=out_d*ss
    sub=sub.resize((size,size), Image.LANCZOS)
    mask=Image.new('L',(size,size),0); d=ImageDraw.Draw(mask)
    rr=(r/(r+2))*size/2
    d.ellipse((size/2-rr,size/2-rr,size/2+rr,size/2+rr),fill=255)
    out=sub.convert('RGBA'); out.putalpha(mask)
    return out.resize((out_d,out_d), Image.LANCZOS)

def place(sprite, W, H, cx=None, cy=None):
    canvas=Image.new('RGBA',(W,H),(0,0,0,0))
    cx=W//2 if cx is None else cx; cy=H//2 if cy is None else cy
    canvas.alpha_composite(sprite,(int(cx-sprite.size[0]/2), int(cy-sprite.size[1]/2)))
    return canvas

# ---- planets: 300x136 masters (4x the 75x34 authoring size); disc diameters from today's icons ×4
PLAN={'jupiter':('jupiter/PIA02873.jpg',136,None,0.99),'mars':('mars/PIA00407.jpg',100,None,1.0),
      'earth':('earth/PIA18033.jpg',114,None,1.0),'venus':('venus/PIA23791.jpg',96,(0,0,1040,1096),0.975)}   # last: radius trim for soft limbs
def planets():
    for name,(f,dia,crop,trim) in PLAN.items():
        im=Image.open(f'{D}/{f}'); cx,cy,r=disc_geometry(im, crop=crop)
        sp=circular_cutout(im,cx,cy,r*trim,dia)
        if name=='jupiter': sp=ImageEnhance.Color(sp).enhance(1.35)
        place(sp,300,136).save(f'{O}/{name}300.png'); print(name,'disc',round(r),'px →',dia)

def mercury():
    m=Image.open(f'{D}/mercury-map/PIA15063.jpg').convert('RGB'); m=m.resize((3066,1533),Image.LANCZOS); mp=m.load(); MW,MH=m.size
    dia=80; ss=4; size=dia*ss; R=size/2-0.5
    out=Image.new('RGBA',(size,size),(0,0,0,0)); op=out.load(); lon0=math.radians(20)
    for y in range(size):
        for x in range(size):
            nx=(x+0.5-size/2)/R; ny=(y+0.5-size/2)/R; d2=nx*nx+ny*ny
            if d2>1: continue
            nz=math.sqrt(1-d2); lat=math.asin(-ny); lon=lon0+math.atan2(nx,nz)
            u=((lon/(2*math.pi))%1.0)*MW; v=(0.5-lat/math.pi)*MH
            c=mp[min(MW-1,int(u)),min(MH-1,int(v))]
            k=(0.45+0.55*nz**0.5)*2.4   # mild limb darkening for roundness; ×2.4: the mosaic is dark grey, the old icon light
            a=255 if d2<0.985 else int(255*max(0,(1-d2)/0.015))
            op[x,y]=(min(255,int(c[0]*k)),min(255,int(c[1]*k)),min(255,int(c[2]*k)),a)
    sp=out.resize((dia,dia),Image.LANCZOS); place(sp,300,136).save(f'{O}/mercury300.png'); print('mercury rendered')

def retone_sun(im):
    """SDO's 304 Å palette is deep red; the old SOHO EIT asset was orange-yellow. Push green up with red,
    brighten (gamma 0.66, ×1.25) to the old asset's mean luminance."""
    R,G,B=im.split()
    bl=lambda v: max(0,v-14)*255/241                     # black-level clamp: JPEG noise in the surround would be lifted by the curve
    lut_r=[min(255,int(255*((bl(v)/255)**0.66)*1.25)) for v in range(256)]
    R2=R.point(lut_r)
    G2=Image.eval(Image.merge('RGB',(R,G,B)).convert('L'), lambda v: v)  # placeholder, replaced below
    rp,gp,bp=R.load(),G.load(),B.load(); W,H=im.size
    out=Image.new('RGB',(W,H)); op=out.load()
    for y in range(H):
        for x in range(W):
            r,g,b=rp[x,y],gp[x,y],bp[x,y]
            rr=lut_r[r]; gg=min(255,int(bl(g)*0.75+bl(r)*0.52)); bb=min(255,int(bl(b)*0.5+bl(g)*0.25))
            op[x,y]=(rr,gg,bb)
    return out

def sun():
    im=Image.open(f'{D}/sdo/sdo_304_4096.jpg').convert('RGB')
    ImageDraw.Draw(im).rectangle((0,3880,2200,4096),fill=(0,0,0))   # mask the SDO caption stamp (black corner)
    # Limb from rows near the equator (the 304 Å poles are dark): L > 60 edges on 13 rows about the
    # vertical centre of the bright set; r from each row's half-width corrected for its offset.
    g=im.convert('L'); gp=g.load(); W,H=im.size
    ys=[y for y in range(0,H,8) if any(gp[x,y]>60 for x in range(0,W,8))]; cy=(min(ys)+max(ys))/2
    rs=[];cxs=[]
    for dy in range(-300,301,50):
        y=int(cy+dy); row=[gp[x,y] for x in range(W)]
        xl=min(x for x in range(W) if row[x]>60); xr=max(x for x in range(W) if row[x]>60)
        cxs.append((xl+xr)/2); rs.append(math.hypot((xr-xl)/2, dy))
    cx=sum(cxs)/len(cxs)
    h2=lambda dy: [math.hypot((max(x for x in range(W) if gp[x,int(cy+dy)]>60)-min(x for x in range(W) if gp[x,int(cy+dy)]>60))/2,0)**2][0]
    cy=cy-(h2(-300)-h2(300))/1200          # circle fit from two symmetric rows
    rs=[]
    for dy in range(-300,301,50):
        y=int(cy+dy); row=[gp[x,y] for x in range(W)]
        xl=min(x for x in range(W) if row[x]>60); xr=max(x for x in range(W) if row[x]>60); rs.append(math.hypot((xr-xl)/2,dy))
    r=sorted(rs)[len(rs)//2]
    PAD=400; padded=Image.new('RGB',(W+2*PAD,H+2*PAD),(0,0,0)); padded.paste(im,(PAD,PAD)); im=padded; cx+=PAD; cy+=PAD
    # orrery sun: disc at 0.77 of half-width as sun.png; half-width = r/0.77 (clamped to the frame)
    hw=r/0.77; box=(int(cx-hw),int(cy-hw),int(cx+hw),int(cy+hw))
    im=retone_sun(im)
    im.crop(box).resize((400,400),Image.LANCZOS).save(f'{O}/sun400.png'); print('sun disc r',round(r),'half-width',round(hw),'fraction',round(r/hw,3))
    # eclipse-sim sun: disc fills the frame (as sunEclipse.png), circular alpha
    circular_cutout(im,cx,cy,r*0.975,160).save(f'{O}/sunEclipse160.png')

def totality():
    im=Image.open(f'{D}/eclipse/NHQ201708210100.jpg').convert('RGB'); W,H=im.size
    # dark disc: pixels below 20 inside the bright corona — find via bbox of dark region near the centre
    g=im.convert('L'); px=g.load()
    xs=[];ys=[]
    for y in range(H//4,3*H//4,2):
        for x in range(W//4,3*W//4,2):
            if px[x,y]<12: xs.append(x); ys.append(y)
    cx=(min(xs)+max(xs))/2; cy=(min(ys)+max(ys))/2; r=(max(xs)-min(xs)+max(ys)-min(ys))/4
    # Frame so the dark disc is the same fraction of the image width as in the old asset (68/316): the
    # eclipse view scales the image by that constant so the disc draws at the Moon's size. The photo
    # only has ~2.4 disc radii of field around the disc, so pad with black and fade the last 15 %.
    FRAC=68.0/316.0; hw=r/FRAC; avail=min(cx,cy,W-cx,H-cy)
    canvas=Image.new('RGB',(int(2*hw),int(2*hw)),(0,0,0)); ox,oy=int(hw-cx),int(hw-cy); canvas.paste(im,(ox,oy)); cp=canvas.load(); CW=canvas.size[0]
    for y in range(CW):
        for x in range(CW):
            d=math.hypot(x-hw,y-hw)
            if d>avail: cp[x,y]=(0,0,0)
            elif d>0.85*avail:
                k=(avail-d)/(0.15*avail); c=cp[x,y]; cp[x,y]=(int(c[0]*k),int(c[1]*k),int(c[2]*k))
    t=canvas.resize((450,450),Image.LANCZOS)
    t=ImageEnhance.Brightness(t).enhance(0.75)
    # Tint toward the old asset's blue corona, toned down from the measured ratio (0.75:1:2.14) to a greyer
    # blue, a touch green-leaning; luminance-normalised; the brightest inner corona eases back to white.
    w=(0.81,1.01,1.44); tp=t.load(); TW,TH=t.size
    for y in range(TH):
        for x in range(TW):
            rr,gg,bb=tp[x,y]; L=0.299*rr+0.587*gg+0.114*bb
            k=min(1,max(0,(L-90)/165))
            tp[x,y]=tuple(min(255,int(L*(wc*(1-k)+k))) for wc in w)
    print(f'totality: disc r {r:.0f} at ({cx:.0f},{cy:.0f}); frame half-width {hw:.0f} (field available {avail:.0f}); SUN_RADIUS_FRACTION unchanged = {FRAC:.3f}')
    t.save(f'{O}/totalEclipse450.png')

def saturn():
    im=Image.open(f'{D}/saturn2/PIA21046.jpg').convert('RGB'); W,H=im.size
    g=im.convert('L'); gp=g.load()
    # bbox of the ring system (lum > 10), then scale so the ring span is 292 px (146 @2x × 2)
    xs=[x for x in range(W) if any(gp[x,y]>10 for y in range(0,H,4))]; ys=[y for y in range(H) if any(gp[x,y]>10 for x in range(0,W,4))]
    x0,x1,y0,y1=min(xs),max(xs)+1,min(ys),max(ys)+1; sub=im.crop((x0,y0,x1,y1)); sw,sh=sub.size
    k=292/sw; ss=4; big=sub.resize((int(sw*k*ss),int(sh*k*ss)),Image.LANCZOS)
    # luminance-keyed alpha: 0 below 6, 1 above 22 (background is pure black)
    L=big.convert('L').point(lambda v: 0 if v<6 else (255 if v>22 else int((v-6)*255/16)))
    L=L.filter(ImageFilter.MaxFilter(3))
    out=big.convert('RGBA'); out.putalpha(L); sp=out.resize((int(sw*k),int(sh*k)),Image.LANCZOS)
    place(sp,300,176).save(f'{O}/saturn300.png'); print('saturn: ring span',sw,'x',sh,'→',sp.size)

def sheet():
    R='/Users/spucci/chronometer-web/.observatory-ref/Resources'; A='/Users/spucci/chronometer-web/src/shared/assets'
    s4=2.46; BG=(32,32,32,255)
    rows=[]  # (label, old_img, new_img, ref_size(w,h), draw4k(w,h), crop_fn)
    for n in ('saturn','jupiter','mars','earth','venus','mercury'):
        new=Image.open(f'{O}/{n}300.png'); rows.append((n, Image.open(f'{R}/{n}.png').convert('RGBA'), new, (new.size[0]//4,new.size[1]//4), (75,34)))
    rows.append(('sun (lighten, a .75)', Image.open(f'{R}/sun.png').convert('RGBA'), Image.open(f'{O}/sun400.png').convert('RGBA'), (100,100)))
    rows.append(('eclipse sun', Image.open(f'{A}/sunEclipse.png').convert('RGBA'), Image.open(f'{O}/sunEclipse160.png'), (74,74)))
    rows.append(('totality', Image.open(f'{A}/totalEclipse.png').convert('RGBA'), Image.open(f'{O}/totalEclipse450.png').convert('RGBA'), (122,122)))
    rows.append(('moon (quadrant)', Image.open(f'{A}/moon300.png').convert('RGBA'), Image.open(f'{R}/moon384@2x.png').convert('RGBA'), (284,284)))
    pad=10; from PIL import ImageDraw
    cells=[]
    for row in rows:
        label,old,new,ref=row[:4]; oref=row[4] if len(row)>4 else ref
        w,h=ref; W4,H4=int(round(w*s4)),int(round(h*s4)); ow,oh=oref
        o1=old.resize((ow,oh),Image.BILINEAR); n1=new.resize((w,h),Image.LANCZOS)
        o4=old.resize((int(round(ow*s4)),int(round(oh*s4))),Image.BILINEAR); n4=new.resize((W4,H4),Image.LANCZOS)
        if label.startswith('moon'):   # show the top-left quadrant at 4K size (699 px disc)
            o4=o4.crop((0,0,350,350)); n4=n4.crop((0,0,350,350)); o1=o1.crop((0,0,142,142)); n1=n1.crop((0,0,142,142))
        cells.append((label,o1,n1,o4,n4))
    col1=max(c[1].size[0] for c in cells); col4=max(c[3].size[0] for c in cells)
    rowh=[max(c[1].size[1],c[3].size[1])+pad+14 for c in cells]
    Wt=pad*5+col1*2+col4*2; Ht=sum(rowh)+pad+24
    out=Image.new('RGBA',(Wt,Ht),BG); d=ImageDraw.Draw(out)
    d.text((pad,6),'reference scale s=1: old | new          4K draw size (×2.46): old (upscaled as today) | new (master downscaled)',fill=(200,200,200,255))
    y=pad+24
    for (label,o1,n1,o4,n4),rh in zip(cells,rowh):
        d.text((pad,y),label,fill=(150,200,255,255)); yy=y+14
        x=pad; out.alpha_composite(o1,(x,yy)); x+=col1+pad; out.alpha_composite(n1,(x,yy)); x+=col1+pad
        out.alpha_composite(o4,(x,yy)); x+=col4+pad; out.alpha_composite(n4,(x,yy)); y+=rh
    out.convert('RGB').save(f'{S}/contact-assets.png'); print('sheet',out.size)

if __name__=='__main__':
    for step in sys.argv[1:]: globals()[step]()
