# Go module zip hash (h1:), as go.sum and sum.golang.org record it: sha256 over the sorted lines
# "<sha256 hex of file>  <path in zip>\n", base64. Reads the zip as data only. Usage: python3 -I gomodhash.py <zip>
import base64, hashlib, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
lines = []
for n in sorted(z.namelist()):
    if n.endswith("/"): continue
    lines.append(f"{hashlib.sha256(z.read(n)).hexdigest()}  {n}\n")
print("h1:" + base64.b64encode(hashlib.sha256("".join(lines).encode()).digest()).decode())
