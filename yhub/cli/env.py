"""Runtime environment and PATH completion.

A macOS desktop app (launched by launchd / Finder / Spotlight) inherits a very thin PATH (usually
just /usr/bin:/bin:/usr/sbin:/sbin): neither the package-manager dirs (/opt/homebrew/bin,
/usr/local/bin) nor the user dirs (~/.local/bin, ~/.cargo/bin). Locally installed tools such as
rclone or opencli are then invisible in GUI mode.

`ensure_path()` appends those standard candidates to `os.environ["PATH"]` at process start.
"""

from __future__ import annotations

import os
from pathlib import Path


def ensure_path() -> None:
    current = os.environ.get("PATH", "")
    existing = set(p for p in current.split(os.pathsep) if p)

    # Common user and package-manager paths (prepended, so they win over /usr/bin)
    priority_candidates = [
        str(Path.home() / ".local" / "bin"),
        str(Path.home() / ".cargo" / "bin"),
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/local/sbin",
    ]

    to_prepend: list[str] = []
    for cand in priority_candidates:
        if cand not in existing and os.path.isdir(cand):
            to_prepend.append(cand)
            existing.add(cand)

    # Then the macOS system paths from /etc/paths and /etc/paths.d/*
    to_append: list[str] = []
    etc_paths = Path("/etc/paths")
    if etc_paths.is_file():
        try:
            for line in etc_paths.read_text(encoding="utf-8").splitlines():
                cand = line.strip()
                if cand and cand not in existing and os.path.isdir(cand):
                    to_append.append(cand)
                    existing.add(cand)
        except OSError:
            pass

    etc_paths_d = Path("/etc/paths.d")
    if etc_paths_d.is_dir():
        try:
            for item in sorted(etc_paths_d.iterdir()):
                if item.is_file():
                    for line in item.read_text(encoding="utf-8").splitlines():
                        cand = line.strip()
                        if cand and cand not in existing and os.path.isdir(cand):
                            to_append.append(cand)
                            existing.add(cand)
        except OSError:
            pass

    if to_prepend or to_append:
        new_parts = to_prepend + [p for p in current.split(os.pathsep) if p] + to_append
        os.environ["PATH"] = os.pathsep.join(new_parts)


# Run once at import time
ensure_path()
