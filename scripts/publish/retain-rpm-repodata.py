#!/usr/bin/env python3
"""Carry cache-addressed RPM metadata across an atomic Pages deployment."""

from __future__ import annotations

import hashlib
import json
import pathlib
import re
import shutil
import sys
import xml.etree.ElementTree as ET


root = pathlib.Path(sys.argv[1])
previous_arg = sys.argv[2]
now = int(sys.argv[3])
retention_seconds = int(sys.argv[4])
repodata = root / "repodata"
manifest_path = repodata / "retention.json"
path_pattern = re.compile(r"repodata/[0-9a-f]{64}-[A-Za-z0-9._+-]+")


def digest(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


files: dict[str, dict[str, object]] = {}
if previous_arg:
    previous = pathlib.Path(previous_arg)
    previous_manifest = previous / "repodata/retention.json"
    if previous_manifest.exists():
        document = json.loads(previous_manifest.read_text())
        if document.get("version") != 1 or not isinstance(document.get("files"), list):
            raise SystemExit(f"invalid RPM retention manifest: {previous_manifest}")
        for record in document["files"]:
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
                raise SystemExit(f"invalid RPM retention record: {record!r}")
            if expires_at <= now:
                continue
            source = previous / relative
            if digest(source) != checksum:
                raise SystemExit(f"retained RPM metadata checksum mismatch: {relative}")
            destination = root / relative
            if destination.exists() and digest(destination) != checksum:
                raise SystemExit(f"RPM metadata path collision: {relative}")
            if not destination.exists():
                shutil.copyfile(source, destination)
            files[relative] = record

namespace = {"repo": "http://linux.duke.edu/metadata/repo"}
metadata = ET.parse(repodata / "repomd.xml")
expires_at = now + retention_seconds
for record in metadata.findall("repo:data", namespace):
    checksum_node = record.find("repo:checksum", namespace)
    location_node = record.find("repo:location", namespace)
    if (
        checksum_node is None
        or checksum_node.attrib.get("type") != "sha256"
        or location_node is None
    ):
        raise SystemExit("repomd.xml must use SHA-256 for every metadata object")
    relative = location_node.attrib.get("href", "")
    checksum = checksum_node.text or ""
    if not path_pattern.fullmatch(relative) or not relative.startswith(f"repodata/{checksum}-"):
        raise SystemExit(f"RPM metadata is not content-addressed: {relative}")
    if digest(root / relative) != checksum:
        raise SystemExit(f"RPM metadata checksum mismatch: {relative}")
    files[relative] = {"expiresAt": expires_at, "path": relative, "sha256": checksum}

manifest = {"files": [files[path] for path in sorted(files)], "version": 1}
manifest_path.write_text(json.dumps(manifest, separators=(",", ":"), sort_keys=True) + "\n")
