import zlib, struct, math, sys
def load(p):
    d=open(p,'rb').read(); i=8; idat=b''; w=h=0
    while i<len(d):
        n=struct.unpack('>I',d[i:i+4])[0]; t=d[i+4:i+8]; c=d[i+8:i+8+n]; i+=12+n
        if t==b'IHDR': w,h,bd,ct=struct.unpack('>IIBB',c[:10])
        elif t==b'IDAT': idat+=c
    raw=zlib.decompress(idat); bpp=4 if ct==6 else 3; stride=w*bpp; rows=[]; prev=bytearray(stride); j=0
    for y in range(h):
        f=raw[j]; j+=1; cur=bytearray(raw[j:j+stride]); j+=stride
        for x in range(stride):
            a=cur[x-bpp] if x>=bpp else 0; b=prev[x]; c=prev[x-bpp] if x>=bpp else 0
            if f==1: cur[x]=(cur[x]+a)&255
            elif f==2: cur[x]=(cur[x]+b)&255
            elif f==3: cur[x]=(cur[x]+(a+b)//2)&255
            elif f==4:
                pp=a+b-c; pa=abs(pp-a); pb=abs(pp-b); pc=abs(pp-c)
                pr=a if pa<=pb and pa<=pc else (b if pb<=pc else c); cur[x]=(cur[x]+pr)&255
        rows.append(cur); prev=cur
    return w,h,bpp,rows
