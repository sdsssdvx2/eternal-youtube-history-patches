#!/usr/bin/env python3
"""Keep Eternal's YouTube compatibility in sync with Morphe stable targets.

The Eternal patch hooks Morphe extension/API classes rather than version-specific
obfuscated YouTube methods, so it follows the non-experimental versions that the
official Morphe patch bundle declares compatible.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

START = "        // MORPHE_COMPAT_START"
END = "        // MORPHE_COMPAT_END"


def stable_targets(constants_text: str) -> list[tuple[str, int]]:
    result: list[tuple[str, int]] = []
    for body in re.findall(r"AppTarget\((.*?)\n\s*\)", constants_text, flags=re.S):
        version = re.search(r'version\s*=\s*"([^"]+)"', body)
        sdk = re.search(r"minSdk\s*=\s*(\d+)", body)
        experimental = re.search(r"isExperimental\s*=\s*true", body)
        if version and sdk and not experimental:
            result.append((version.group(1), int(sdk.group(1))))
    if not result:
        raise RuntimeError("No stable Morphe YouTube targets were found")
    return result


def render(targets: list[tuple[str, int]]) -> str:
    blocks: list[str] = []
    for version, sdk in targets:
        blocks.append(
            "        AppTarget(\n"
            f'            version = "{version}",\n'
            f"            minSdk = {sdk}\n"
            "        )"
        )
    return START + "\n" + ",\n".join(blocks) + "\n" + END


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: sync_morphe_compat.py <official Constants.kt> <EternalHistoryPatch.kt>", file=sys.stderr)
        return 2

    official_path = Path(sys.argv[1])
    eternal_path = Path(sys.argv[2])
    official = official_path.read_text(encoding="utf-8")
    eternal = eternal_path.read_text(encoding="utf-8")
    targets = stable_targets(official)

    start = eternal.find(START)
    end = eternal.find(END)
    if start < 0 or end < 0 or end < start:
        raise RuntimeError("Compatibility markers are missing from EternalHistoryPatch.kt")
    end += len(END)

    updated = eternal[:start] + render(targets) + eternal[end:]
    if updated == eternal:
        print("Eternal compatibility already matches Morphe stable targets:", ", ".join(v for v, _ in targets))
        return 0

    eternal_path.write_text(updated, encoding="utf-8")
    print("Updated Eternal compatibility to:", ", ".join(v for v, _ in targets))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
