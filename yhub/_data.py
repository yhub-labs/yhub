"""Locate data directories shipped with the package (source tree and wheel).

``capsules/`` is the read-only sample capsule layer, built from ``capsule-src/`` by
``make capsules``. It sits at the repository root, but the wheel force-includes it as
``yhub/_data/capsules`` so it does not land in ``site-packages/capsules``.

Returns ``None`` when nothing is found; callers treat that as "this layer does not
exist" rather than raising.
"""

from __future__ import annotations

from pathlib import Path


def data_dir(name: str) -> Path | None:
    """Return a bundled data directory, or None when it does not exist."""
    pkg = Path(__file__).resolve().parent
    for path in (pkg / "_data" / name, pkg.parent / name):
        if path.is_dir():
            return path
    return None


def bundled_capsules_dir() -> Path | None:
    """Read-only bundled capsule layer (a build artifact)."""
    return data_dir("capsules")


def frontend_dist() -> Path | None:
    """Frontend build output: ``yhub/web/dist`` in the wheel, ``<repo>/web/dist`` in source."""
    pkg = Path(__file__).resolve().parent
    for path in (pkg / "web" / "dist", pkg.parent / "web" / "dist"):
        if path.is_dir():
            return path
    return None
