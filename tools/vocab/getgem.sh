#!/bin/bash
# getgem.sh NAME VERSION OUTDIR: download a gem from rubygems.org, check its sha256 against the registry, unpack data.tar.gz (never install or run).
set -euo pipefail
N=$1; V=$2; O=$3
avail=$(df -g / | tail -1 | awk '{print $4}'); [ "$avail" -lt 6 ] && { echo "disk under 6 GB" >&2; exit 3; }
[ -e "$O" ] && { echo "exists: $O" >&2; exit 2; }
mkdir -p "$O"
META=$(dirname "$0")/../libmaps/meta/gem_$N.json
[ -s "$META" ] || curl -sf -m 60 -A "vitasta-libmap/0.1" "https://rubygems.org/api/v1/versions/$N.json" -o "$META"
SHA=$(python3 -I -c "import json,sys; print(next(v['sha'] for v in json.load(open(sys.argv[1])) if v['number']==sys.argv[2] and v.get('platform','ruby')=='ruby'))" "$META" "$V")
curl -sf -m 120 -A "vitasta-libmap/0.1" "https://rubygems.org/downloads/$N-$V.gem" -o "$O/pkg.gem"
GOT=$(shasum -a 256 "$O/pkg.gem" | awk '{print $1}')
[ "$GOT" = "$SHA" ] || { echo "sha mismatch" >&2; rm -f "$O/pkg.gem"; exit 4; }
mkdir -p "$O/package" && tar -xOf "$O/pkg.gem" data.tar.gz | tar -xzf - -C "$O/package" && rm -f "$O/pkg.gem"
echo "$O/package"
