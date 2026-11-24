#!/bin/bash
# getcomposer.sh VENDOR/NAME VERSION OUTDIR: Packagist's metadata for the version names a repository and an exact
# commit (dist.reference); that commit alone is shallow-fetched from that repository (git checks every object
# against its hash) and checked out as data (never installed or run). Writes OUTDIR/integrity.txt.
set -euo pipefail
P=$1; V=$2; O=$3
avail=$(df -g / | tail -1 | awk '{print $4}'); [ "$avail" -lt 6 ] && { echo "disk under 6 GB" >&2; exit 3; }
[ -e "$O" ] && { echo "exists: $O" >&2; exit 2; }
mkdir -p "$O"
read -r REPO REF < <(curl -sf -m 60 -A "vitasta-libmap/0.1" "https://repo.packagist.org/p2/$P.json" | python3 -I -c "
import json,sys,re
d=json.load(sys.stdin)['packages'][sys.argv[1]]
v=next(x for x in d if x['version'] in (sys.argv[2], 'v'+sys.argv[2]))
src=v.get('source') or {}
ref=(v.get('dist') or {}).get('reference') or src.get('reference')
url=src.get('url') or ''
assert re.fullmatch(r'[0-9a-f]{40}', ref or ''), 'no commit reference'
assert re.match(r'^https://github\.com/[\w.-]+/[\w.-]+(\.git)?$', url), 'unexpected source '+url
print(url, ref)" "$P" "$V")
mkdir -p "$O/package"
( cd "$O/package" && git init -q && git remote add origin "$REPO" && git -c protocol.version=2 fetch -q --depth 1 origin "$REF" && git -c advice.detachedHead=false checkout -q FETCH_HEAD )
HEAD=$(git -C "$O/package" rev-parse HEAD)
[ "$HEAD" = "$REF" ] || { echo "commit mismatch $HEAD vs $REF" >&2; exit 4; }
rm -rf "$O/package/.git"
echo "git sha $REF via packagist" > "$O/integrity.txt"
echo "$O/package"
