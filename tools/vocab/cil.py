# A small ECMA-335 (.NET metadata) reader: parses a DLL's bytes as data, never loads or runs it.
# Gives type definitions (namespace, name, base, nested parent), their fields, properties (with type), methods
# (name, flags, return type and parameter types, parameter names) and the string literals each method body
# loads (ldstr), plus member references (calls to other assemblies' methods). Pure Python, no dependencies.
import struct

class Reader:
    def __init__(self, data: bytes):
        self.d = data
        e_lfanew = struct.unpack_from("<I", data, 0x3C)[0]
        assert data[e_lfanew:e_lfanew + 4] == b"PE\0\0"
        coff = e_lfanew + 4
        nsec, = struct.unpack_from("<H", data, coff + 2)
        optsize, = struct.unpack_from("<H", data, coff + 16)
        opt = coff + 20
        magic, = struct.unpack_from("<H", data, opt)
        dd = opt + (96 if magic == 0x10B else 112)
        cli_rva, cli_size = struct.unpack_from("<II", data, dd + 14 * 8)
        self.secs = []
        sec = opt + optsize
        for i in range(nsec):
            vsize, va, rawsize, rawptr = struct.unpack_from("<IIII", data, sec + i * 40 + 8)
            self.secs.append((va, max(vsize, rawsize), rawptr))
        cli = self.off(cli_rva)
        md_rva, md_size = struct.unpack_from("<II", data, cli + 8)
        md = self.off(md_rva)
        assert struct.unpack_from("<I", data, md)[0] == 0x424A5342
        vlen, = struct.unpack_from("<I", data, md + 12)
        p = md + 16 + vlen
        nstreams, = struct.unpack_from("<H", data, p + 2)
        p += 4
        self.streams = {}
        for _ in range(nstreams):
            o, s = struct.unpack_from("<II", data, p)
            p += 8
            e = data.index(b"\0", p)
            name = data[p:e].decode()
            p = (e + 4) & ~3
            self.streams[name] = (md + o, s)
        self._tables()

    def off(self, rva):
        for va, size, raw in self.secs:
            if va <= rva < va + size: return rva - va + raw
        raise ValueError(rva)

    # heaps
    def string(self, i):
        b, _ = self.streams["#Strings"]
        e = self.d.index(b"\0", b + i)
        return self.d[b + i:e].decode("utf-8", "replace")
    def blob(self, i):
        b, _ = self.streams["#Blob"]
        n, k = self._cu(b + i)
        return self.d[b + i + k:b + i + k + n]
    def us(self, i):
        b, _ = self.streams["#US"]
        n, k = self._cu(b + i)
        raw = self.d[b + i + k:b + i + k + n]
        return raw[:-1].decode("utf-16-le", "replace") if raw else ""
    def _cu(self, p):
        x = self.d[p]
        if x & 0x80 == 0: return x, 1
        if x & 0xC0 == 0x80: return ((x & 0x3F) << 8) | self.d[p + 1], 2
        return ((x & 0x1F) << 24) | (self.d[p + 1] << 16) | (self.d[p + 2] << 8) | self.d[p + 3], 4

    def _tables(self):
        b, _ = self.streams.get("#~") or self.streams["#-"]
        hs = self.d[b + 6]
        valid, = struct.unpack_from("<Q", self.d, b + 8)
        p = b + 24
        self.rows = [0] * 64
        for t in range(64):
            if valid >> t & 1:
                self.rows[t], = struct.unpack_from("<I", self.d, p); p += 4
        sz = {"s": 4 if hs & 1 else 2, "g": 4 if hs & 2 else 2, "b": 4 if hs & 4 else 2}
        def idx(t): return 2 if self.rows[t] < 0x10000 else 4
        def coded(ts, bits): return 2 if max(self.rows[t] for t in ts if t is not None) < (1 << (16 - bits)) else 4
        TDR = ([2, 1, 0x1B], 2); HC = ([4, 8, 0x17], 2)
        HCA = ([6, 4, 1, 2, 8, 9, 0x0A, 0, 0x0E, 0x17, 0x14, 0x11, 0x1A, 0x1B, 0x20, 0x23, 0x26, 0x27, 0x28, 0x2A, 0x2C, 0x2B], 5)
        HFM = ([4, 8], 1); HDS = ([2, 6, 0x20], 2); MRP = ([2, 1, 0x1A, 6, 0x1B], 3); HS = ([0x14, 0x17], 1)
        MDO = ([6, 0x0A], 1); MF = ([4, 6], 1); IMPL = ([0x26, 0x23, 0x27], 2); CAT = ([None, None, 6, 0x0A, None], 3)
        RS = ([0, 0x1A, 0x23, 1], 2); TOMD = ([2, 6], 1)
        c = lambda spec: coded(*spec)
        S, G, B = sz["s"], sz["g"], sz["b"]
        schema = {
            0x00: [2, S, G, G, G], 0x01: [c(RS), S, S], 0x02: [4, S, S, c(TDR), idx(4), idx(6)], 0x03: [idx(4)],
            0x04: [2, S, B], 0x05: [idx(6)], 0x06: [4, 2, 2, S, B, idx(8)], 0x07: [idx(8)], 0x08: [2, 2, S],
            0x09: [idx(2), c(TDR)], 0x0A: [c(MRP), S, B], 0x0B: [2, c(HC), B], 0x0C: [c(HCA), c(CAT), B],
            0x0D: [c(HFM), B], 0x0E: [2, c(HDS), B], 0x0F: [2, 4, idx(2)], 0x10: [4, idx(4)], 0x11: [B],
            0x12: [idx(2), idx(0x14)], 0x13: [idx(0x14)], 0x14: [2, S, c(TDR)], 0x15: [idx(2), idx(0x17)],
            0x16: [idx(0x17)], 0x17: [2, S, B], 0x18: [2, idx(6), c(HS)], 0x19: [idx(2), c(MDO), c(MDO)],
            0x1A: [S], 0x1B: [B], 0x1C: [2, c(MF), S, idx(0x1A)], 0x1D: [4, idx(4)], 0x1E: [4, 4],
            0x1F: [4], 0x20: [4, 2, 2, 2, 2, 4, B, S, S], 0x21: [4], 0x22: [4, 4, 4], 0x23: [2, 2, 2, 2, 4, B, S, S, B],
            0x24: [4, idx(0x23)], 0x25: [4, 4, 4, idx(0x23)], 0x26: [4, S, B], 0x27: [4, 4, S, S, c(IMPL)],
            0x28: [4, 4, S, c(IMPL)], 0x29: [idx(2), idx(2)], 0x2A: [2, 2, c(TOMD), S], 0x2B: [c(MDO), B], 0x2C: [idx(0x2A), c(TDR)],
        }
        self.tab = {}
        for t in range(0x2D):
            if not self.rows[t]: continue
            cols = schema[t]
            rs = sum(cols)
            self.tab[t] = (p, rs, cols)
            p += rs * self.rows[t]

    def row(self, t, i):
        """1-based row i of table t, as a list of column values"""
        base, rs, cols = self.tab[t]
        p = base + (i - 1) * rs
        out = []
        for w in cols:
            out.append(struct.unpack_from("<H" if w == 2 else "<I", self.d, p)[0]); p += w
        return out

    # coded index decoding
    @staticmethod
    def dec(v, tables, bits):
        return tables[v & ((1 << bits) - 1)], v >> bits

    def typename(self, t, i):
        if t == 2: r = self.row(2, i); return self.full(i)
        if t == 1:
            r = self.row(1, i); ns, n = self.string(r[2]), self.string(r[1])
            return (ns + "." if ns else "") + n
        if t == 0x1B: return self.sigtype(self.blob(self.row(0x1B, i)[0]))[0]
        return "?"

    def full(self, i):
        r = self.row(2, i)
        ns, n = self.string(r[2]), self.string(r[1])
        par = self.nested.get(i)
        if par: return self.full(par) + "+" + n
        return (ns + "." if ns else "") + n

    def sigtype(self, b, p=0):
        """Decode one type in a signature blob: (name, next offset)"""
        e = b[p]; p += 1
        prim = {1: "void", 2: "bool", 3: "char", 4: "sbyte", 5: "byte", 6: "short", 7: "ushort", 8: "int", 9: "uint", 0x0A: "long", 0x0B: "ulong",
                0x0C: "float", 0x0D: "double", 0x0E: "string", 0x18: "nint", 0x19: "nuint", 0x1C: "object", 0x16: "TypedReference"}
        if e in prim: return prim[e], p
        if e in (0x11, 0x12):  # valuetype / class + TypeDefOrRef
            v, k = self._cub(b, p); p += k
            t, i = self.dec(v, [2, 1, 0x1B], 2)
            return self.typename(t, i), p
        if e in (0x0F, 0x10, 0x1D, 0x45):  # ptr, byref, szarray, pinned
            n, p = self.sigtype(b, p); return n + ("[]" if e == 0x1D else ""), p
        if e == 0x15:  # genericinst: (class|valuetype) TypeDefOrRef count args
            n, p = self.sigtype(b, p)
            cnt, k = self._cub(b, p); p += k
            args = []
            for _ in range(cnt):
                a, p = self.sigtype(b, p); args.append(a)
            return f"{n.split('`')[0]}<{','.join(args)}>", p
        if e in (0x13, 0x1E):  # var, mvar
            v, k = self._cub(b, p); return f"!{v}", p + k
        if e in (0x1F, 0x20):  # cmod
            v, k = self._cub(b, p); return self.sigtype(b, p + k)
        if e == 0x14:  # array
            n, p = self.sigtype(b, p); rank, k = self._cub(b, p); p += k
            ns, k = self._cub(b, p); p += k
            for _ in range(ns): _, k = self._cub(b, p); p += k
            nl, k = self._cub(b, p); p += k
            for _ in range(nl): _, k = self._cub(b, p); p += k
            return n + "[,]", p
        return f"?{e:x}", p

    def _cub(self, b, p):
        x = b[p]
        if x & 0x80 == 0: return x, 1
        if x & 0xC0 == 0x80: return ((x & 0x3F) << 8) | b[p + 1], 2
        return ((x & 0x1F) << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3], 4

    def methodsig(self, b):
        p = 0
        cc = b[p]; p += 1
        if cc & 0x10: _, k = self._cub(b, p); p += k
        n, k = self._cub(b, p); p += k
        ret, p = self.sigtype(b, p)
        ps = []
        for _ in range(n):
            if p >= len(b): break
            if b[p] == 0x41: p += 1  # sentinel
            t, p = self.sigtype(b, p); ps.append(t)
        return ret, ps

    def propsig(self, b):
        p = 1
        n, k = self._cub(b, p); p += k
        t, p = self.sigtype(b, p)
        return t

    def ldstrs(self, rva):
        """String literals a method body loads, in order"""
        return self.body(rva)[0]

    def calls(self, rva):
        """What a body calls (call, callvirt, newobj, ldftn): (declaring type, member name) pairs"""
        out = []
        for tok in self.body(rva)[1]:
            t, i = tok >> 24, tok & 0xFFFFFF
            try:
                if t == 0x0A:
                    par, name, _ = self.row(0x0A, i)
                    pt, pi = self.dec(par, [2, 1, 0x1A, 6, 0x1B], 3)
                    out.append((self.typename(pt, pi) if pt in (1, 2, 0x1B) else "?", self.string(name)))
                elif t == 0x06:
                    out.append((self.owner_of(i), self.string(self.row(6, i)[3])))
            except Exception: pass
        return out

    def owner_of(self, m):
        if not hasattr(self, "_owners"):
            self._owners = {}
            nt = self.rows[2]
            for i in range(1, nt + 1):
                a = self.row(2, i)[5]; b = self.row(2, i + 1)[5] if i < nt else self.rows[6] + 1
                for k in range(a, b): self._owners[k] = i
        return self.full(self._owners.get(m, 1))

    def events(self, rva):
        """Ordered body events: ("str", text) for ldstr and UTF-8 literals (ldsflda of an RVA field + its length),
        ("call", declaring type, name) for call/callvirt/newobj"""
        self.body(rva)
        return self._events

    def field_rva(self, fidx):
        if not hasattr(self, "_frva"):
            self._frva = {}
            for i in range(1, self.rows[0x1D] + 1):
                rva, f = self.row(0x1D, i); self._frva[f] = rva
        return self._frva.get(fidx)

    def _tokname(self, tok):
        t, i = tok >> 24, tok & 0xFFFFFF
        try:
            if t == 0x0A:
                par, name, _ = self.row(0x0A, i)
                pt, pi = self.dec(par, [2, 1, 0x1A, 6, 0x1B], 3)
                return (self.typename(pt, pi) if pt in (1, 2, 0x1B) else "?", self.string(name))
            if t == 0x06: return (self.owner_of(i), self.string(self.row(6, i)[3]))
            if t == 0x2B:
                inst, _ = self.row(0x2B, i)
                mt, mi = self.dec(inst, [6, 0x0A], 1)
                return self._tokname((mt << 24) | mi)
        except Exception: return None
        return None

    def body(self, rva):
        self._events = []
        if not rva: return [], []
        try: o = self.off(rva)
        except ValueError: return []
        h = self.d[o]
        if h & 3 == 2: size = h >> 2; code = o + 1
        else:
            flags_size, = struct.unpack_from("<H", self.d, o)
            size, = struct.unpack_from("<I", self.d, o + 4)
            code = o + (flags_size >> 12) * 4
        out = []; toks = []
        body = self.d[code:code + size]
        # opcode scan: only ldstr (0x72 + token 0x70xxxxxx) is needed; walk with operand sizes to stay aligned
        i = 0
        one = {0x20: 4, 0x21: 8, 0x22: 4, 0x23: 8, 0x1F: 1, 0x2B: 1, 0x2C: 1, 0x2D: 1, 0x2E: 1, 0x2F: 1, 0x30: 1, 0x31: 1, 0x32: 1, 0x33: 1, 0x34: 1,
               0x35: 1, 0x36: 1, 0x37: 1, 0xDE: 1, 0x0E: 1, 0x0F: 1, 0x10: 1, 0x11: 1, 0x12: 1, 0x13: 1}
        four = set(range(0x38, 0x45)) | {0x27, 0x28, 0x29, 0x6F, 0x70, 0x71, 0x72, 0x73, 0x74, 0x75, 0x79, 0x7B, 0x7C, 0x7D, 0x7E, 0x7F, 0x80, 0x81,
                                         0x8C, 0x8D, 0x8F, 0xA3, 0xA4, 0xA5, 0xC2, 0xC6, 0xD0, 0xDD}
        while i < len(body):
            op = body[i]; i += 1
            if op == 0xFE:
                op2 = body[i] if i < len(body) else 0; i += 1
                if op2 in (0x06, 0x07) and i + 4 <= len(body):
                    tok, = struct.unpack_from("<I", body, i); toks.append(tok); i += 4
                elif op2 in (0x15, 0x16, 0x1C, 0x1D): i += 4
                elif op2 in (0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E): i += 2
                elif op2 == 0x12: i += 1
                continue
            if op == 0x72:
                tok, = struct.unpack_from("<I", body, i)
                if tok >> 24 == 0x70:
                    v = self.us(tok & 0xFFFFFF); out.append(v); self._events.append(("str", v))
                i += 4
            elif op in (0x28, 0x6F, 0x73) and i + 4 <= len(body):
                tok, = struct.unpack_from("<I", body, i); toks.append(tok); i += 4
                nm = self._tokname(tok)
                if nm: self._events.append(("call", nm[0], nm[1]))
            elif op == 0x7F and i + 4 <= len(body):
                # ldsflda of a field with data: a UTF-8 literal when the next instruction is ldc.i4 <length>
                tok, = struct.unpack_from("<I", body, i); i += 4
                n = None
                if i < len(body):
                    nx = body[i]
                    if 0x16 <= nx <= 0x1E: n = nx - 0x16
                    elif nx == 0x1F and i + 1 < len(body): n = body[i + 1]
                    elif nx == 0x20 and i + 4 < len(body): n, = struct.unpack_from("<i", body, i + 1)
                frva = self.field_rva(tok & 0xFFFFFF) if tok >> 24 == 0x04 else None
                if frva and n and 0 < n < 200:
                    try:
                        o = self.off(frva); raw = self.d[o:o + n]
                        txt = raw.decode("utf-8")
                        if txt.isprintable(): out.append(txt); self._events.append(("str", txt))
                    except Exception: pass
            elif op == 0x45:
                n, = struct.unpack_from("<I", body, i); i += 4 + 4 * n
            elif op in four: i += 4
            elif op in one: i += one[op]
        return out, toks

    def attributes(self):
        """Custom attributes on properties and fields: {(table, row): [(attribute type, first string argument)]}"""
        out = {}
        HCA = [6, 4, 1, 2, 8, 9, 0x0A, 0, 0x0E, 0x17, 0x14, 0x11, 0x1A, 0x1B, 0x20, 0x23, 0x26, 0x27, 0x28, 0x2A, 0x2C, 0x2B]
        for i in range(1, self.rows[0x0C] + 1):
            par, typ, val = self.row(0x0C, i)
            pt, pi = self.dec(par, HCA, 5)
            if pt not in (0x17, 4): continue
            ct, ci = self.dec(typ, [None, None, 6, 0x0A, None], 3)
            try:
                owner = self._tokname((ct << 24) | ci)
            except Exception: owner = None
            if not owner: continue
            b = self.blob(val)
            arg = None
            if len(b) > 3 and b[0] == 1 and b[1] == 0 and b[2] != 0xFF:
                n, k = self._cub(b, 2)
                try: arg = b[2 + k:2 + k + n].decode("utf-8")
                except Exception: arg = None
            out.setdefault((pt, pi), []).append((owner[0], arg))
        return out

    def types(self):
        """All type definitions with their members"""
        self.nested = {}
        for i in range(1, self.rows[0x29] + 1):
            n, enc = self.row(0x29, i)
            self.nested[n] = enc
        nt, nf, nm = self.rows[2], self.rows[4], self.rows[6]
        # property map: type -> property range
        pmap = []
        for i in range(1, self.rows[0x15] + 1): pmap.append(self.row(0x15, i))
        props_of = {}
        for k, (t, first) in enumerate(pmap):
            last = pmap[k + 1][1] if k + 1 < len(pmap) else self.rows[0x17] + 1
            props_of[t] = range(first, last)
        # method semantics: property -> getter/setter
        sem = {}
        for i in range(1, self.rows[0x18] + 1):
            flags, meth, assoc = self.row(0x18, i)
            t, idx = self.dec(assoc, [0x14, 0x17], 1)
            if t == 0x17: sem.setdefault(idx, []).append((flags, meth))
        out = []
        for i in range(1, nt + 1):
            r = self.row(2, i)
            flags, ext = r[0], r[3]
            fstart, mstart = r[4], r[5]
            if i < nt: nr = self.row(2, i + 1); fend, mend = nr[4], nr[5]
            else: fend, mend = nf + 1, nm + 1
            base = None
            if ext:
                t, k = self.dec(ext, [2, 1, 0x1B], 2)
                base = self.typename(t, k)
            methods = []
            for m in range(mstart, mend):
                rva, iflags, mflags, name, sig, pstart = self.row(6, m)
                ret, ps = self.methodsig(self.blob(sig))
                methods.append({"id": m, "name": self.string(name), "public": (mflags & 7) == 6, "static": bool(mflags & 0x10), "ret": ret, "params": ps, "rva": rva})
            props = []
            for pidx in props_of.get(i, []):
                pf, pname, psig = self.row(0x17, pidx)
                props.append({"id": pidx, "name": self.string(pname), "type": self.propsig(self.blob(psig)), "accessors": [m for _, m in sem.get(pidx, [])]})
            fields = []
            for fidx in range(fstart, fend):
                ff, fname, fsig = self.row(4, fidx)
                fields.append({"name": self.string(fname), "static": bool(ff & 0x10), "literal": bool(ff & 0x40)})
            out.append({"id": i, "name": self.full(i), "public": (flags & 7) in (1, 2), "interface": bool(flags & 0x20), "base": base, "methods": methods, "props": props, "fields": fields})
        return out
