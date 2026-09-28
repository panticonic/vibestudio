#!/usr/bin/env python3
"""Refresh Base's offline scaffold SVGs; never called by builds or startup.

Usage: python3 scripts/sync-project-lucide-icons.py /path/to/templates/base
"""

import base64
import hashlib
import io
from pathlib import Path
import re
import sys
import tarfile
import urllib.request

VERSION = "1.27.0"
INTEGRITY = "ev1Wufm+RsKpQ6CfmS0PgYF+NTB1aaltfE+jUgBYGB8PV5b5qqHpzsTLPsMWFRFdpVMv66eIK8/Xf9d8cl3HhA=="


def main():
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    base = Path(sys.argv[1]).resolve()
    if not (base / "skills/workspace-dev/create-project.ts").is_file():
        raise SystemExit("Expected a Base template checkout")
    url = f"https://registry.npmjs.org/lucide-static/-/lucide-static-{VERSION}.tgz"
    with urllib.request.urlopen(url, timeout=60) as response:
        archive = response.read()
    if base64.b64encode(hashlib.sha512(archive).digest()).decode() != INTEGRITY:
        raise SystemExit("Lucide archive integrity mismatch")
    destination = base / "skills/workspace-dev/assets/icons"
    count = 0
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as source:
        for member in source.getmembers():
            if not member.isfile():
                continue
            if re.fullmatch(r"package/icons/[a-z0-9-]+\.svg", member.name):
                target = destination / "lucide" / Path(member.name).name
                count += 1
            elif member.name == "package/LICENSE":
                target = destination / "LUCIDE-LICENSE"
            else:
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with source.extractfile(member) as content:
                target.write_bytes(content.read())
    print(f"Synced {count} Lucide Static {VERSION} SVGs to {destination}")


if __name__ == "__main__":
    main()
