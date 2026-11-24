# Generate vocabulary for several releases of one SDK: fetch one release (registry + hash check), run the language
# generator on it, delete it, next. Usage: python3 -I releases.py <mode go|nuget> <package> <outdir> <version>...
import json, os, shutil, subprocess, sys
T = os.path.dirname(os.path.abspath(__file__)); L = os.environ.get("VOCAB_WORK", os.path.join(T, "work"))
mode, pkg, outdir, versions = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4:]
fetch = {"go": "getgo.sh", "nuget": "getnuget.sh", "maven": "getmaven.sh", "gem": "getgem.sh", "composer": "getcomposer.sh"}[mode]
gen = {"go": "gen_go.py", "nuget": "gen_cs.py", "maven": "gen_kt.py", "gem": "gen_rb.py", "composer": "gen_php.py"}[mode]
for v in versions:
    out = os.path.join(outdir, f"{mode}-{pkg.replace('/', '_')}@{v}.json")
    if os.path.exists(out): print("have", v); continue
    d = os.path.join(L, "w-vr-" + v)
    p = subprocess.run(["bash", os.path.join(T, fetch), pkg, v, d], capture_output=True, text=True)
    if p.returncode != 0:
        print("fetch failed", v, p.stderr.strip()[:200], flush=True); shutil.rmtree(d, ignore_errors=True)
        if p.returncode == 3: sys.exit(3)
        continue
    src = os.path.join(d, "package", f"{pkg}@{v}") if mode == "go" else os.path.join(d, "package")
    integ = open(os.path.join(d, "integrity.txt")).read().strip() if os.path.exists(os.path.join(d, "integrity.txt")) else {"go": "sum.golang.org h1", "nuget": "catalog sha512", "maven": "sha512", "gem": "rubygems sha256"}[mode]
    g = subprocess.run([sys.executable, "-I", os.path.join(T, gen), src, pkg, v], capture_output=True, text=True)
    shutil.rmtree(d, ignore_errors=True)
    if g.returncode != 0: print("gen failed", v, g.stderr.strip()[-300:], flush=True); continue
    j = json.loads(g.stdout); j["integrity"] = integ
    open(out, "w").write(json.dumps(j))
    print("gen", v, len(j["methods"]), "methods", len(j["paramTypes"]), "params types", integ, flush=True)
