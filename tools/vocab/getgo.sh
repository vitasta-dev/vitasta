#!/bin/bash
# getgo.sh MODULE VERSION OUTDIR: module zip from proxy.golang.org, its h1: hash checked against sum.golang.org,
# unzipped as data (never built or run). Module paths with capitals use the proxy's !lowercase escaping.
set -euo pipefail
M=$1; V=$2; O=$3
avail=$(df -g / | tail -1 | awk '{print $4}'); [ "$avail" -lt 6 ] && { echo "disk under 6 GB" >&2; exit 3; }
[ -e "$O" ] && { echo "exists: $O" >&2; exit 2; }
mkdir -p "$O"
E=$(python3 -I -c "import re,sys;print(re.sub(r'[A-Z]',lambda m:'!'+m.group(0).lower(),sys.argv[1]))" "$M")
curl -sf -m 180 -A "vitasta-libmap/0.1" "https://proxy.golang.org/$E/@v/$V.zip" -o "$O/mod.zip"
WANT=$(curl -sf -m 60 -A "vitasta-libmap/0.1" "https://sum.golang.org/lookup/$E@$V" | awk -v m="$M" -v v="$V" '$1==m && $2==v {print $3}')
GOT=$(python3 -I "$(dirname "$0")/gomodhash.py" "$O/mod.zip")
[ -n "$WANT" ] && [ "$GOT" = "$WANT" ] || { echo "hash mismatch ($GOT vs $WANT)" >&2; rm -f "$O/mod.zip"; exit 4; }
mkdir -p "$O/package" && unzip -q "$O/mod.zip" -d "$O/package" && rm -f "$O/mod.zip"
echo "$O/package"
