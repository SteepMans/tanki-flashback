import sys, struct
from swfabc import raw, tags, R, parse_cpool

# opcode -> (name, operand kinds)
OPS = {
0x01:('bkpt',''),0x02:('nop',''),0x03:('throw',''),0x04:('getsuper','m'),0x05:('setsuper','m'),
0x06:('dxns','s'),0x07:('dxnslate',''),0x08:('kill','u'),0x09:('label',''),
0x0c:('ifnlt','j'),0x0d:('ifnle','j'),0x0e:('ifngt','j'),0x0f:('ifnge','j'),
0x10:('jump','j'),0x11:('iftrue','j'),0x12:('iffalse','j'),0x13:('ifeq','j'),0x14:('ifne','j'),
0x15:('iflt','j'),0x16:('ifle','j'),0x17:('ifgt','j'),0x18:('ifge','j'),0x19:('ifstricteq','j'),
0x1a:('ifstrictne','j'),0x1b:('lookupswitch','L'),0x1c:('pushwith',''),0x1d:('popscope',''),
0x1e:('nextname',''),0x1f:('hasnext',''),0x20:('pushnull',''),0x21:('pushundefined',''),
0x23:('nextvalue',''),0x24:('pushbyte','b'),0x25:('pushshort','u'),0x26:('pushtrue',''),
0x27:('pushfalse',''),0x28:('pushnan',''),0x29:('pop',''),0x2a:('dup',''),0x2b:('swap',''),
0x2c:('pushstring','s'),0x2d:('pushint','i'),0x2e:('pushuint','U'),0x2f:('pushdouble','d'),
0x30:('pushscope',''),0x31:('pushnamespace','u'),0x32:('hasnext2','uu'),
0x40:('newfunction','u'),0x41:('call','u'),0x42:('construct','u'),0x43:('callmethod','uu'),
0x44:('callstatic','uu'),0x45:('callsuper','mu'),0x46:('callproperty','mu'),0x47:('returnvoid',''),
0x48:('returnvalue',''),0x49:('constructsuper','u'),0x4a:('constructprop','mu'),
0x4c:('callproplex','mu'),0x4e:('callsupervoid','mu'),0x4f:('callpropvoid','mu'),
0x53:('applytype','u'),0x55:('newobject','u'),0x56:('newarray','u'),0x57:('newactivation',''),
0x58:('newclass','u'),0x59:('getdescendants','m'),0x5a:('newcatch','u'),
0x5d:('findpropstrict','m'),0x5e:('findproperty','m'),0x5f:('finddef','m'),
0x60:('getlex','m'),0x61:('setproperty','m'),0x62:('getlocal','u'),0x63:('setlocal','u'),
0x64:('getglobalscope',''),0x65:('getscopeobject','b'),0x66:('getproperty','m'),
0x68:('initproperty','m'),0x6a:('deleteproperty','m'),0x6c:('getslot','u'),0x6d:('setslot','u'),
0x6e:('getglobalslot','u'),0x6f:('setglobalslot','u'),0x70:('convert_s',''),0x71:('esc_xelem',''),
0x72:('esc_xattr',''),0x73:('convert_i',''),0x74:('convert_u',''),0x75:('convert_d',''),
0x76:('convert_b',''),0x77:('convert_o',''),0x78:('checkfilter',''),
0x80:('coerce','m'),0x82:('coerce_a',''),0x85:('coerce_s',''),0x86:('astype','m'),
0x87:('astypelate',''),0x90:('negate',''),0x91:('increment',''),0x92:('inclocal','u'),
0x93:('decrement',''),0x94:('declocal','u'),0x95:('typeof',''),0x96:('not',''),0x97:('bitnot',''),
0xa0:('add',''),0xa1:('subtract',''),0xa2:('multiply',''),0xa3:('divide',''),0xa4:('modulo',''),
0xa5:('lshift',''),0xa6:('rshift',''),0xa7:('urshift',''),0xa8:('bitand',''),0xa9:('bitor',''),
0xaa:('bitxor',''),0xab:('equals',''),0xac:('strictequals',''),0xad:('lessthan',''),
0xae:('lessequals',''),0xaf:('greaterthan',''),0xb0:('greaterequals',''),0xb1:('instanceof',''),
0xb2:('istype','m'),0xb3:('istypelate',''),0xb4:('in',''),
0xc0:('increment_i',''),0xc1:('decrement_i',''),0xc2:('inclocal_i','u'),0xc3:('declocal_i','u'),
0xc4:('negate_i',''),0xc5:('add_i',''),0xc6:('subtract_i',''),0xc7:('multiply_i',''),
0xd0:('getlocal0',''),0xd1:('getlocal1',''),0xd2:('getlocal2',''),0xd3:('getlocal3',''),
0xd4:('setlocal0',''),0xd5:('setlocal1',''),0xd6:('setlocal2',''),0xd7:('setlocal3',''),
0xef:('debug','X'),0xf0:('debugline','u'),0xf1:('debugfile','s'),0xf2:('bkptline','u'),
0xf3:('timestamp',''),
}

class Abc:
    def __init__(s, r):
        s.ints=[0]; n=r.u30()
        for _ in range(max(n-1,0)): s.ints.append(r.s32())
        s.uints=[0]; n=r.u30()
        for _ in range(max(n-1,0)): s.uints.append(r.u30())
        s.dbls=[0.0]; n=r.u30()
        for _ in range(max(n-1,0)): s.dbls.append(r.d64())
        s.st=['*']; n=r.u30()
        for _ in range(max(n-1,0)): s.st.append(r.str())
        s.ns=[(0,0)]; n=r.u30()
        for _ in range(max(n-1,0)):
            k=r.u8(); s.ns.append((k,r.u30()))
        s.nss=[[]]; n=r.u30()
        for _ in range(max(n-1,0)):
            c=r.u30(); s.nss.append([r.u30() for _ in range(c)])
        s.mn=[(0,None)]; n=r.u30()
        for _ in range(max(n-1,0)):
            k=r.u8()
            if k in (0x07,0x0d): s.mn.append(('Q',(r.u30(),r.u30())))
            elif k in (0x0f,0x10): s.mn.append(('RTQ',(r.u30(),)))
            elif k in (0x11,0x12): s.mn.append(('RTQL',()))
            elif k in (0x09,0x0e): s.mn.append(('M',(r.u30(),r.u30())))
            elif k in (0x1b,0x1c): s.mn.append(('MA',(r.u30(),)))
            elif k==0x1d:
                a=r.u30(); c=r.u30(); s.mn.append(('TN',(a,[r.u30() for _ in range(c)])))
            else: s.mn.append(('?',()))
        s.rest(r)

    def sname(s,i): return s.st[i] if 0<=i<len(s.st) else '?'
    def nsname(s,i): return s.sname(s.ns[i][1]) if 0<=i<len(s.ns) else '?'
    def mname(s,i):
        if not (0<i<len(s.mn)): return '*'
        k,a=s.mn[i]
        if not isinstance(k,str): return '*'
        if k=='Q':
            p=s.nsname(a[0]); n=s.sname(a[1]); return (p+':'+n) if p else n
        if k=='M': return s.sname(a[1])
        if k=='MA': return s.sname(a[0])
        if k=='TN': return s.mname(a[0])+'<>'
        return '<'+k+'>'

    def traits(s,r):
        tc=r.u30(); res=[]
        for _ in range(tc):
            name=s.mname(r.u30()); tk=r.u8(); kind=tk&0x0f
            if kind in (0,6):
                r.u30(); ti=r.u30(); vi=r.u30()
                if vi: r.u8()
                res.append(('slot',name,None))
            elif kind in (1,2,3):
                r.u30(); mi=r.u30()
                res.append((('method','getter','setter')[kind-1],name,mi))
            elif kind==4:
                r.u30(); r.u30(); res.append(('class',name,None))
            elif kind==5:
                r.u30(); mi=r.u30(); res.append(('function',name,mi))
            if tk>>4 & 0x04:
                mc=r.u30()
                for _ in range(mc): r.u30()
        return res

    def rest(s,r):
        n=r.u30(); s.methods=[]
        for _ in range(n):
            pc=r.u30(); rt=r.u30(); pt=[r.u30() for _ in range(pc)]
            nm=r.u30(); fl=r.u8()
            if fl&0x08:
                oc=r.u30()
                for _ in range(oc): r.u30(); r.u8()
            if fl&0x80:
                for _ in range(pc): r.u30()
            s.methods.append({'name':s.sname(nm),'ret':s.mname(rt),
                              'params':[s.mname(t) for t in pt],'owner':None})
        n=r.u30()
        for _ in range(n):
            r.u30(); c=r.u30()
            for _ in range(c): r.u30(); r.u30()
        n=r.u30(); s.instances=[]
        for _ in range(n):
            nm=r.u30(); sup=r.u30(); fl=r.u8()
            if fl&0x08: r.u30()
            ic=r.u30(); ifaces=[s.mname(r.u30()) for _ in range(ic)]
            iinit=r.u30()
            inst={'name':s.mname(nm),'super':s.mname(sup),'ifaces':ifaces,
                  'iinit':iinit,'traits':s.traits(r)}
            s.instances.append(inst)
        for inst in s.instances:
            inst['cinit']=r.u30(); inst['ctraits']=s.traits(r)
        n=r.u30(); s.scripts=[]
        for _ in range(n):
            init=r.u30(); s.scripts.append({'init':init,'traits':s.traits(r)})
        # ownership map
        for inst in s.instances:
            for t in inst['traits']+inst['ctraits']:
                if t[2] is not None and isinstance(t[2],int) and t[2]<len(s.methods):
                    s.methods[t[2]]['owner']=inst['name']+'.'+t[1]
            if inst['iinit']<len(s.methods): s.methods[inst['iinit']]['owner']=inst['name']+'.ctor'
            if inst['cinit']<len(s.methods): s.methods[inst['cinit']]['owner']=inst['name']+'.cinit'
        n=r.u30(); s.bodies={}
        for _ in range(n):
            mi=r.u30(); r.u30(); r.u30(); r.u30(); r.u30()
            cl=r.u30(); code=r.d[r.p:r.p+cl]; r.p+=cl
            ec=r.u30()
            for _ in range(ec):
                r.u30(); r.u30(); r.u30(); r.u30(); r.u30()
            s.traits(r)
            s.bodies[mi]=code

    def dis(s, code):
        r=R(code); out=[]
        while r.p < len(code):
            off=r.p; op=r.u8(); nm,kinds=OPS.get(op,('op%02x'%op,''))
            args=[]
            try:
                for k in kinds:
                    if k=='u': args.append(str(r.u30()))
                    elif k=='b': args.append(str(r.u8()))
                    elif k=='i': args.append(hex(s.ints[r.u30()%len(s.ints)]))
                    elif k=='U': args.append(hex(s.uints[r.u30()%len(s.uints)]))
                    elif k=='d': args.append(str(s.dbls[r.u30()%len(s.dbls)]))
                    elif k=='s': args.append(repr(s.sname(r.u30())))
                    elif k=='m': args.append(s.mname(r.u30()))
                    elif k=='j':
                        v=r.d[r.p]|(r.d[r.p+1]<<8)|(r.d[r.p+2]<<16); r.p+=3
                        if v&0x800000: v-=0x1000000
                        args.append(str(r.p+v))
                    elif k=='X':
                        r.u8(); r.u30(); r.u8(); r.u30()
                    elif k=='L':
                        r.p+=3; c=r.u30()
                        r.p+=3*(c+1)
            except Exception:
                break
            out.append('%5d %-16s %s'%(off,nm,' '.join(args)))
        return out

def load(path):
    body=raw(path); res=[]
    for code,data in tags(body):
        if code not in (72,82): continue
        r=R(data)
        if code==82:
            r.p+=4
            while r.d[r.p]!=0: r.p+=1
            r.p+=1
        r.p+=4
        res.append(Abc(r))
    return res

if __name__=='__main__':
    path=sys.argv[1]; needle=sys.argv[2]
    for abc in load(path):
        for mi,code in abc.bodies.items():
            lines=abc.dis(code)
            if any(needle in l for l in lines):
                m=abc.methods[mi] if mi<len(abc.methods) else {}
                print('===== method %d %s (%s):%s'%(mi,m.get('owner') or m.get('name'),
                      ', '.join(m.get('params',[])), m.get('ret')))
                print('\n'.join(lines))
                print()
