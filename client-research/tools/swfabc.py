import sys, struct, zlib, lzma, io

def raw(path):
    d = open(path, 'rb').read()
    sig = d[:3]
    flen = struct.unpack('<I', d[4:8])[0]
    if sig == b'FWS':
        return d[8:]
    if sig == b'CWS':
        return zlib.decompress(d[8:])
    if sig == b'ZWS':
        r = d[12:17] + b'\xff' * 8 + d[17:]
        return lzma.LZMADecompressor(format=lzma.FORMAT_ALONE).decompress(r)
    raise Exception('sig ' + str(sig))

def skip_rect(b, o):
    n = b[o] >> 3
    bits = 5 + 4 * n
    return o + (bits + 7) // 8

def tags(body):
    o = skip_rect(body, 0) + 4  # rect + framerate(2) + framecount(2)
    out = []
    while o + 2 <= len(body):
        th = struct.unpack('<H', body[o:o+2])[0]; o += 2
        code = th >> 6; ln = th & 0x3f
        if ln == 0x3f:
            ln = struct.unpack('<I', body[o:o+4])[0]; o += 4
        out.append((code, body[o:o+ln]))
        o += ln
        if code == 0:
            break
    return out

class R:
    def __init__(s, d): s.d = d; s.p = 0
    def u8(s):
        v = s.d[s.p]; s.p += 1; return v
    def u30(s):
        r = 0; sh = 0
        for _ in range(5):
            b = s.u8(); r |= (b & 0x7f) << sh; sh += 7
            if not b & 0x80: break
        return r
    def s32(s): return s.u30()
    def d64(s):
        v = struct.unpack('<d', s.d[s.p:s.p+8])[0]; s.p += 8; return v
    def str(s):
        n = s.u30(); v = s.d[s.p:s.p+n]; s.p += n
        return v.decode('utf8', 'replace')

def parse_cpool(r):
    n = r.u30()
    for _ in range(max(n-1, 0)): r.s32()          # ints
    n = r.u30()
    for _ in range(max(n-1, 0)): r.u30()          # uints
    n = r.u30()
    for _ in range(max(n-1, 0)): r.d64()          # doubles
    n = r.u30(); strings = ['*']
    for _ in range(max(n-1, 0)): strings.append(r.str())
    n = r.u30(); ns = [(0, 0)]
    for _ in range(max(n-1, 0)):
        k = r.u8(); ns.append((k, r.u30()))
    n = r.u30(); nss = [[]]
    for _ in range(max(n-1, 0)):
        c = r.u30(); nss.append([r.u30() for _ in range(c)])
    n = r.u30(); mn = [(0, None)]
    for _ in range(max(n-1, 0)):
        k = r.u8()
        if k in (0x07, 0x0d):   mn.append(('Q', (r.u30(), r.u30())))
        elif k in (0x0f, 0x10): mn.append(('RTQ', (r.u30(),)))
        elif k in (0x11, 0x12): mn.append(('RTQL', ()))
        elif k in (0x09, 0x0e): mn.append(('M', (r.u30(), r.u30())))
        elif k in (0x1b, 0x1c): mn.append(('MA', (r.u30(),)))
        elif k == 0x1d:
            a = r.u30(); c = r.u30()
            mn.append(('TN', (a, [r.u30() for _ in range(c)])))
        else: mn.append(('?%x' % k, ()))
    return strings, ns, nss, mn

def dump(path):
    body = raw(path)
    res = []
    for code, data in tags(body):
        if code != 82:  # DoABC2
            if code != 72: continue
        r = R(data)
        if code == 82:
            r.p += 4
            while r.d[r.p] != 0: r.p += 1
            r.p += 1
        r.p += 4  # minor/major
        strings, ns, nss, mn = parse_cpool(r)
        res.append((strings, ns, nss, mn, r))
    return res

if __name__ == '__main__':
    for p in sys.argv[1:]:
        print('=====', p)
        for strings, ns, nss, mn, r in dump(p):
            print('strings:', len(strings))
            for s in strings:
                print(repr(s))
