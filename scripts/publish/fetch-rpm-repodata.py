#!/usr/bin/env python3
"""Fetch the live immutable RPM metadata that cached repomd files can name."""

from __future__ import annotations

import hashlib
import json
import pathlib
import re
import sys
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET


base_url = sys.argv[1].rstrip("/")
destination = pathlib.Path(sys.argv[2])
now = int(sys.argv[3])
retention_seconds = int(sys.argv[4])
repodata = destination / "repodata"
repodata.mkdir(parents=True, exist_ok=True)
path_pattern = re.compile(r"repodata/[0-9a-f]{64}-[A-Za-z0-9._+-]+")


def fetch(relative: str, *, optional: bool = False) -> bytes | None:
    try:
        with urllib.request.urlopen(f"{base_url}/{relative}") as response:
            return response.read()
    except urllib.error.HTTPError as error:
        if optional and error.code == 404:
            return None
        raise


repomd_bytes = fetch("repodata/repomd.xml", optional=True)
if repomd_bytes is None:
    raise SystemExit(0)
(repodata / "repomd.xml").write_bytes(repomd_bytes)
(repodata / "repomd.xml.asc").write_bytes(fetch("repodata/repomd.xml.asc"))

files: dict[str, dict[str, object]] = {}
manifest_bytes = fetch("repodata/retention.json", optional=True)
if manifest_bytes is not None:
    document = json.loads(manifest_bytes)
    if document.get("version") != 1 or not isinstance(document.get("files"), list):
        raise SystemExit("invalid published RPM retention manifest")
    candidates = list(document["files"])
else:
    candidates = []

# repomd.xml and retention.json are separate mutable CDN objects. They can name
# adjacent deployments, so neither is an alternative to the other: preserve
# the union or a later publication could delete the exact generation a client
# just learned from its cached repomd.xml.
namespace = {"repo": "http://linux.duke.edu/metadata/repo"}
metadata = ET.fromstring(repomd_bytes)
for record in metadata.findall("repo:data", namespace):
    checksum_node = record.find("repo:checksum", namespace)
    location_node = record.find("repo:location", namespace)
    if checksum_node is None or location_node is None:
        raise SystemExit("invalid published repomd.xml")
    candidates.append(
        {
            "expiresAt": now + retention_seconds,
            "path": location_node.attrib.get("href"),
            "sha256": checksum_node.text,
        }
    )

for record in candidates:
    relative = record.get("path")
    checksum = record.get("sha256")
    expires_at = record.get("expiresAt")
    if (
        not isinstance(relative, str)
        or not path_pattern.fullmatch(relative)
        or not isinstance(checksum, str)
        or not re.fullmatch(r"[0-9a-f]{64}", checksum)
        or not isinstance(expires_at, int)
    ):
        raise SystemExit(f"invalid published RPM retention record: {record!r}")
    if expires_at <= now:
        continue
    payload = fetch(relative)
    if hashlib.sha256(payload).hexdigest() != checksum:
        raise SystemExit(f"published RPM metadata checksum mismatch: {relative}")
    output = destination / relative
    output.write_bytes(payload)
    files[relative] = record

manifest = {"files": [files[path] for path in sorted(files)], "version": 1}
(repodata / "retention.json").write_text(
    json.dumps(manifest, separators=(",", ":"), sort_keys=True) + "\n"
)
