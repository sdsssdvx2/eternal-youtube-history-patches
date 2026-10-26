#!/usr/bin/env python3
from __future__ import annotations

import re
import sys
from pathlib import Path


VERSION_RE = re.compile(r"^version\s*=\s*.*$", re.MULTILINE)
SEMVER_RE = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$")


def main() -> int:
    if len(sys.argv) != 2 or not SEMVER_RE.fullmatch(sys.argv[1]):
        print("usage: set_gradle_version.py <semver>", file=sys.stderr)
        return 2

    version = sys.argv[1]
    path = Path("gradle.properties")
    text = path.read_text(encoding="utf-8")
    matches = list(VERSION_RE.finditer(text))
    if len(matches) != 1:
        raise RuntimeError(f"expected exactly one version assignment in {path}, found {len(matches)}")

    updated = VERSION_RE.sub(f"version = {version}", text, count=1)
    path.write_text(updated, encoding="utf-8")

    verify = path.read_text(encoding="utf-8")
    if f"version = {version}" not in verify:
        raise RuntimeError("gradle.properties version verification failed")

    print(f"Set {path} version to {version}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
