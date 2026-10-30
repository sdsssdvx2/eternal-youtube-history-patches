#!/usr/bin/env python3
"""Keep Eternal's YouTube compatibility in sync with Morphe stable targets.

Eternal follows the non-experimental versions declared by the official Morphe
patch bundle, but the server-side Android builder can intentionally stay pinned
to an older validated YouTube base. That pinned target is source-of-truth in
android-update-status.json and must never be silently removed by compatibility
sync, otherwise Morphe Desktop will skip Eternal while still producing a valid
APK with zero Eternal patches applied.
"""
from __future__ import annotations

import json
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


def pinned_server_target(status_path: Path) -> tuple[str, int]:
    data = json.loads(status_path.read_text(encoding="utf-8"))
    youtube = data.get("youtube")
    if not isinstance(youtube, dict):
        raise RuntimeError("android-update-status.json has no youtube object")
    version = str(youtube.get("version") or "").strip()
    try:
        min_sdk = int(youtube.get("min_sdk"))
    except (TypeError, ValueError) as exc:
        raise RuntimeError("android-update-status.json youtube.min_sdk is invalid") from exc
    if not re.fullmatch(r"\d+(?:\.\d+)+", version):
        raise RuntimeError("android-update-status.json youtube.version is invalid")
    if min_sdk < 1:
        raise RuntimeError("android-update-status.json youtube.min_sdk is invalid")
    return version, min_sdk


def version_key(version: str) -> tuple[int, ...]:
    return tuple(int(part) for part in version.split("."))


def merged_targets(
    official_targets: list[tuple[str, int]], pinned_target: tuple[str, int]
) -> list[tuple[str, int]]:
    # Deduplicate by version. If Morphe already declares the pinned target, retain
    # Morphe's minSdk because that is the upstream compatibility declaration.
    by_version: dict[str, int] = {}
    for version, sdk in official_targets:
        by_version.setdefault(version, sdk)
    pinned_version, pinned_sdk = pinned_target
    by_version.setdefault(pinned_version, pinned_sdk)
    return sorted(by_version.items(), key=lambda item: version_key(item[0]), reverse=True)


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
    if len(sys.argv) not in (3, 4):
        print(
            "usage: sync_morphe_compat.py <official Constants.kt> <EternalHistoryPatch.kt> "
            "[android-update-status.json]",
            file=sys.stderr,
        )
        return 2

    official_path = Path(sys.argv[1])
    eternal_path = Path(sys.argv[2])
    status_path = Path(sys.argv[3]) if len(sys.argv) == 4 else Path("android-update-status.json")
    official = official_path.read_text(encoding="utf-8")
    eternal = eternal_path.read_text(encoding="utf-8")
    official_targets = stable_targets(official)
    pinned_target = pinned_server_target(status_path)
    targets = merged_targets(official_targets, pinned_target)

    start = eternal.find(START)
    end = eternal.find(END)
    if start < 0 or end < 0 or end < start:
        raise RuntimeError("Compatibility markers are missing from EternalHistoryPatch.kt")
    end += len(END)

    updated = eternal[:start] + render(targets) + eternal[end:]
    target_text = ", ".join(v for v, _ in targets)
    if updated == eternal:
        print("Eternal compatibility already matches Morphe + pinned server target:", target_text)
        return 0

    eternal_path.write_text(updated, encoding="utf-8")
    print("Updated Eternal compatibility to Morphe + pinned server target:", target_text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
