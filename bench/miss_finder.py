# Dev-only miss finder (item 9). Never shipped, never shown to users.
# For each repo: search flags in a file that names the provider op (op_in_file) with no finding of our build within
# +-3 lines in that file are written as candidates for a person to check (and, if real, to add to a dev key).
# Usage: python3 -I miss_finder.py <search dir> <findings dir> <tag> <out.jsonl>
import json, glob, os, re, sys, collections
# Tests, fixtures, docs, translations and generated files aren't where a fix goes
NOISE = re.compile(r'(^|/)(tests?|spec|specs|__tests__|__mocks__|fixtures?|e2e|docs?|examples?|locales?|i18n|translations?|dist|build|vendor)(/|$)|\.(test|spec)\.|_test\.|\.(md|mdx|txt|ya?ml|json|lock|snap|po)$', re.I)
sdir, fdir, tag, out = sys.argv[1:5]
rows = []; per = collections.Counter()
for sp in sorted(glob.glob(os.path.join(sdir, '*.search.json'))):
    n = os.path.basename(sp)[:-len('.search.json')]
    fp = os.path.join(fdir, f'{n}.{tag}.json')
    if not os.path.exists(fp): continue
    flags = json.load(open(sp)).get('flags', [])
    finds = [f['usage'] for f in json.load(open(fp)).get('findings', [])]
    byfile = collections.defaultdict(list)
    for u in finds: byfile[u['file']].append(u['line'])
    seen = set()
    for f in flags:
        if not f.get('op_in_file') or NOISE.search(f['file']): continue
        k = (f['file'], f['line'])
        if k in seen or any(abs(l - f['line']) <= 3 for l in byfile.get(f['file'], [])): continue
        seen.add(k)
        rows.append({'repo': n.replace('__', '/'), 'file': f['file'], 'line': f['line'], 'rec': f.get('rec'), 'tag': tag})
        per[n] += 1
with open(out, 'w') as o:
    for r in rows: o.write(json.dumps(r) + '\n')
print(f'{len(rows)} candidates in {len(per)} repos ->', out)
for n, c in per.most_common(10): print(' ', n, c)
