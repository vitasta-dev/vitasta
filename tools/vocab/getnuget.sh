#!/bin/bash
# getnuget.sh ID VERSION OUTDIR: .nupkg from api.nuget.org, its SHA-512 checked against the catalog's packageHash,
# unzipped as data (never loaded or run).
set -euo pipefail
I=$1; V=$2; O=$3
avail=$(df -g / | tail -1 | awk '{print $4}'); [ "$avail" -lt 6 ] && { echo "disk under 6 GB" >&2; exit 3; }
[ -e "$O" ] && { echo "exists: $O" >&2; exit 2; }
mkdir -p "$O"
LI=$(echo "$I" | tr '[:upper:]' '[:lower:]'); LV=$(echo "$V" | tr '[:upper:]' '[:lower:]')
curl -sf -m 300 -A "vitasta-libmap/0.1" "https://api.nuget.org/v3-flatcontainer/$LI/$LV/$LI.$LV.nupkg" -o "$O/pkg.nupkg"
LEAF=$(curl -sf -m 60 -A "vitasta-libmap/0.1" --compressed "https://api.nuget.org/v3/registration5-gz-semver2/$LI/$LV.json" | python3 -I -c "import json,sys;print(json.load(sys.stdin)['catalogEntry'])")
WANT=$(curl -sf -m 60 -A "vitasta-libmap/0.1" "$LEAF" | python3 -I -c "import json,sys;d=json.load(sys.stdin);assert d['packageHashAlgorithm']=='SHA512';print(d['packageHash'])")
GOT=$(python3 -I -c "import hashlib,base64,sys;print(base64.b64encode(hashlib.sha512(open(sys.argv[1],'rb').read()).digest()).decode())" "$O/pkg.nupkg")
[ "$GOT" = "$WANT" ] || { echo "hash mismatch" >&2; rm -f "$O/pkg.nupkg"; exit 4; }
mkdir -p "$O/package" && unzip -q "$O/pkg.nupkg" -d "$O/package" && rm -f "$O/pkg.nupkg"
echo "$O/package"
