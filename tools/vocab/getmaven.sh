#!/bin/bash
# getmaven.sh GROUP:ARTIFACT VERSION OUTDIR: the -sources.jar from Maven Central, checked against its .sha512 (or,
# where a release publishes none, its .sha1 over HTTPS), plus its .asc signature when published, verified with gpg in
# a throwaway keyring (the signer's key from a public keyserver; its fingerprint is recorded). Unzipped as data,
# never compiled or run. Writes OUTDIR/integrity.txt with the checks that passed.
set -euo pipefail
GA=$1; V=$2; O=$3
G=${GA%%:*}; A=${GA#*:}
avail=$(df -g / | tail -1 | awk '{print $4}'); [ "$avail" -lt 6 ] && { echo "disk under 6 GB" >&2; exit 3; }
[ -e "$O" ] && { echo "exists: $O" >&2; exit 2; }
mkdir -p "$O"
U="https://repo1.maven.org/maven2/${G//.//}/$A/$V/$A-$V-sources.jar"
curl -sf -m 300 -A "vitasta-libmap/0.1" "$U" -o "$O/src.jar"
CHECK=""
if WANT=$(curl -sf -m 60 -A "vitasta-libmap/0.1" "$U.sha512" | awk '{print $1}') && [ -n "$WANT" ]; then
  [ "$(shasum -a 512 "$O/src.jar" | awk '{print $1}')" = "$WANT" ] || { echo "sha512 mismatch" >&2; rm -f "$O/src.jar"; exit 4; }
  CHECK="sha512"
else
  WANT=$(curl -sf -m 60 -A "vitasta-libmap/0.1" "$U.sha1" | awk '{print $1}')
  [ -n "$WANT" ] && [ "$(shasum -a 1 "$O/src.jar" | awk '{print $1}')" = "$WANT" ] || { echo "sha1 mismatch" >&2; rm -f "$O/src.jar"; exit 4; }
  CHECK="sha1"
fi
if command -v gpg >/dev/null && curl -sf -m 60 -A "vitasta-libmap/0.1" "$U.asc" -o "$O/src.jar.asc"; then
  # the signer's key over HTTPS from the keyserver's lookup API (gpg's own keyserver helper can't start under long
  # paths), imported into a throwaway keyring
  K="$(cd "$(dirname "$0")/.." && pwd)/g$$"; mkdir -m 700 -p "$K"
  ID=$(GNUPGHOME="$K" gpg --batch --no-autostart --list-packets "$O/src.jar.asc" 2>/dev/null | grep -o "keyid [0-9A-F]*" | head -1 | awk '{print $2}')
  if [ -n "$ID" ] && curl -sf -m 60 -A "vitasta-libmap/0.1" "https://keyserver.ubuntu.com/pks/lookup?op=get&options=mr&search=0x$ID" -o "$O/key.asc" \
     && { GNUPGHOME="$K" gpg --batch --quiet --no-autostart --import "$O/key.asc" 2>/dev/null || GNUPGHOME="$K" gpg --batch --quiet --no-autostart --import "$O/key.asc" 2>/dev/null; } \
     && GNUPGHOME="$K" gpg --batch --no-autostart --verify "$O/src.jar.asc" "$O/src.jar" 2>"$O/gpg.log"; then
    FPR=$(GNUPGHOME="$K" gpg --batch --no-autostart --with-colons --fingerprint "$ID" 2>/dev/null | awk -F: '/^fpr/ {print $10; exit}')
    CHECK="$CHECK asc:good-signature(key $FPR, not certified)"
  else
    grep -q "BAD signature" "$O/gpg.log" 2>/dev/null && { echo "bad signature" >&2; rm -f "$O/src.jar"; exit 4; }
    CHECK="$CHECK asc:not-verified(key $ID not found)"
  fi
  rm -rf "$K" "$O/src.jar.asc" "$O/gpg.log" "$O/key.asc"
fi
mkdir -p "$O/package" && unzip -q "$O/src.jar" -d "$O/package" && rm -f "$O/src.jar"
echo "$CHECK" > "$O/integrity.txt"
echo "$O/package"
