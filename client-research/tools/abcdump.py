import sys
from swfabc import raw, tags, R, parse_cpool

def load(path):
    body = raw(path)
    out = []
    for code, data in tags(body):
        if code not in (72, 82):
            continue
        r = R(data)
        if code == 82:
            r.p += 4
            while r.d[r.p] != 0: r.p += 1
            r.p += 1
        r.p += 4
        strings, ns, nss, mn = parse_cpool(r)
        out.append(Abc(strings, ns, nss, mn, r))
    return out

class Abc:
    def __init__(s, strings, ns, nss, mn, r):
        s.st = strings; s.ns = ns; s.nss = nss; s.mn = mn
        s.parse_rest(r)

    def sname(s, i):
        return s.st[i] if 0 <= i < len(s.st) else '?'

    def nsname(s, i):
        return s.sname(s.ns[i][1]) if 0 <= i < len(s.ns) else '?'

    def mname(s, i):
        if not (0 < i < len(s.mn)): return '*'
        k, a = s.mn[i]
        if not isinstance(k, str): return '*'
        if k == 'Q':
            p = s.nsname(a[0]); n = s.sname(a[1])
            return (p + ':' + n) if p else n
        if k == 'M':  return s.sname(a[1])
        if k == 'MA': return s.sname(a[0])
        if k == 'TN': return s.mname(a[0]) + '<>'
        return '<' + k + '>'

    def parse_rest(s, r):
        n = r.u30(); s.methods = []
        for _ in range(n):
            pc = r.u30(); rt = r.u30()
            pt = [r.u30() for _ in range(pc)]
            nm = r.u30(); fl = r.u8()
            if fl & 0x08:
                oc = r.u30()
                for _ in range(oc): r.u30(); r.u8()
            if fl & 0x80:
                for _ in range(pc): r.u30()
            s.methods.append({'name': s.sname(nm), 'ret': s.mname(rt),
                              'params': [s.mname(t) for t in pt]})
        n = r.u30(); s.meta = []
        for _ in range(n):
            nm = r.u30(); c = r.u30()
            items = [(r.u30(), r.u30()) for _ in range(c)]
            s.meta.append((s.sname(nm), [(s.sname(a), s.sname(b)) for a, b in items]))

        def traits():
            tc = r.u30(); res = []
            for _ in range(tc):
                name = s.mname(r.u30())
                tk = r.u8(); kind = tk & 0x0f
                if kind in (0, 6):        # slot / const
                    r.u30(); ti = r.u30(); vi = r.u30()
                    if vi: r.u8()
                    res.append(('slot', name, s.mname(ti)))
                elif kind in (1, 2, 3):   # method/getter/setter
                    r.u30(); mi = r.u30()
                    res.append((('method', 'getter', 'setter')[kind - 1], name, mi))
                elif kind == 4:           # class
                    r.u30(); r.u30(); res.append(('class', name, None))
                elif kind == 5:           # function
                    r.u30(); mi = r.u30(); res.append(('function', name, mi))
                if tk >> 4 & 0x04:
                    mc = r.u30()
                    for _ in range(mc): r.u30()
            return res

        n = r.u30(); s.instances = []
        for _ in range(n):
            nm = r.u30(); sup = r.u30(); fl = r.u8()
            if fl & 0x08: r.u30()
            ic = r.u30(); ifaces = [s.mname(r.u30()) for _ in range(ic)]
            iinit = r.u30()
            s.instances.append({'name': s.mname(nm), 'super': s.mname(sup),
                                'interface': bool(fl & 0x04), 'ifaces': ifaces,
                                'iinit': iinit, 'traits': traits()})
        for inst in s.instances:
            r.u30()  # cinit
            inst['ctraits'] = traits()

if __name__ == '__main__':
    pat = sys.argv[2].lower() if len(sys.argv) > 2 else ''
    for abc in load(sys.argv[1]):
        for inst in abc.instances:
            if pat and pat not in inst['name'].lower():
                continue
            kind = 'interface' if inst['interface'] else 'class'
            print('%s %s extends %s%s' % (kind, inst['name'], inst['super'],
                  (' implements ' + ', '.join(inst['ifaces'])) if inst['ifaces'] else ''))
            for t in inst['traits'] + inst.get('ctraits', []):
                if t[0] in ('method', 'getter', 'setter', 'function'):
                    m = abc.methods[t[2]] if t[2] < len(abc.methods) else {'params': [], 'ret': '?'}
                    print('    %-7s %s(%s):%s' % (t[0], t[1], ', '.join(m['params']), m['ret']))
                else:
                    print('    %-7s %s:%s' % (t[0], t[1], t[2]))
