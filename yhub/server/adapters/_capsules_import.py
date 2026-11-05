"""Capsule library extras: the **metadata overlay** plus import/delete (data layer for `capsules.py`).

`scan_capsules()` stays the single source of truth for "what is a capsule": a file in the library is
one, whether it was dropped there by hand or imported through `POST /api/capsules/import`. What the
import path adds is *declared* metadata — a name / icon / description / order per capsule — instead of
only the bookmark-style trio scraped out of the file's `<head>`.

The overlay lives in `capsules.json` in the config root, keyed by **relpath** (the capsule's identity
in the URL), shape:

    {"version": 1, "capsules": {"hello/index.html": {"title": "…", "icon": "…", "order": 10}}}

Rules that keep the two sources from fighting (2026-11):

  * the **file is still the truth for existence**. A manifest entry whose file is gone decorates
    nothing: it is reported as `stale_metadata` by the list and pruned on the next metadata write.
    One-way deletion only — the manifest never deletes or hides a capsule.
  * every field is optional. An absent field falls through to the scraped value, so a capsule that
    was never imported still shows up with its `<title>` — importing is a convenience, never a gate.
  * `order` is the only field with an effect outside the display layer: it sorts the list (lower
    first, ties by relpath), and the list order is what the launcher / wall read.

Boundaries (same discipline as the entry path in `capsules.py`): imports land directly in the
**user** library root as a single `.html`/`.htm` file, names are sanitized to one path segment, and
deletes only touch the user layer — a bundled (system-layer) capsule is removed by disabling it, not
by deleting the software's file.
"""

from __future__ import annotations

import json
import os
import re
import shutil
from pathlib import Path
from typing import Any

from yhub.i18n import tr

from . import ToolError

META_FILE = "capsules.json"
META_VERSION = 1

#: Field caps — the same spirit as the scraped trio (title 80 / description 300 in `capsules.py`)
TITLE_MAX = 80
DESCRIPTION_MAX = 300
ICON_MAX = 64 * 1024  # inlined `data:image/…` icons are the big case
ORDER_ABS_MAX = 1_000_000
#: Sort weight for a capsule that declares no order (after every explicit one)
ORDER_FALLBACK = ORDER_ABS_MAX + 1

_META_FIELDS = ("title", "icon", "description", "order")
_IMPORT_SUFFIXES = (".html", ".htm")
#: One path segment only: separators, control characters and the characters Windows refuses are dropped
_BAD_NAME = re.compile(r"[\x00-\x1f\x7f/\\:*?\"<>|]")
_NAME_MAX = 120


# ------------------------------------------------------------------ metadata store


def meta_path() -> Path:
    """`capsules.json` next to `settings.json` (one config root; `YHUB_CONFIG_DIR` moves both)."""
    from .settings import config_dir

    return config_dir() / META_FILE


def _read_doc() -> dict[str, Any]:
    path = meta_path()
    try:
        raw = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return {"version": META_VERSION, "capsules": {}}
    if not isinstance(raw, dict):
        return {"version": META_VERSION, "capsules": {}}
    capsules = raw.get("capsules")
    return {
        "version": META_VERSION,
        "capsules": capsules if isinstance(capsules, dict) else {},
    }


def read_meta() -> dict[str, dict[str, Any]]:
    """The whole overlay, sanitized leniently: a broken field is dropped, never fatal.

    Read every time (no cache), so an edit by hand in `capsules.json` takes effect on the next list,
    exactly like `settings.json`.
    """
    out: dict[str, dict[str, Any]] = {}
    for raw_relpath, raw_meta in _read_doc()["capsules"].items():
        relpath = str(raw_relpath).strip().strip("/")
        if not relpath or not isinstance(raw_meta, dict):
            continue
        cleaned: dict[str, Any] = {}
        for field in _META_FIELDS:
            if field not in raw_meta:
                continue
            try:
                value = _clean_field(field, raw_meta[field])
            except ToolError:
                continue  # stored garbage falls through to the scraped value
            if value is not None:
                cleaned[field] = value
        if cleaned:
            out[relpath] = cleaned
    return out


def _write_doc(meta: dict[str, dict[str, Any]]) -> None:
    """Atomic write (temp + `os.replace`), the same discipline as `settings.json`."""
    from .settings import config_dir

    path = meta_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    doc = {"version": META_VERSION, "capsules": meta}
    body = json.dumps(doc, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        tmp.write_text(body, "utf-8")
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink(missing_ok=True)


def _clean_field(field: str, value: Any) -> Any:
    """One stored/incoming value → its canonical form, or None (= clear). Bad input → ToolError."""
    if value is None:
        return None
    if field == "order":
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ToolError(
                tr("capsules.meta_order_invalid"),
                hint=tr("capsules.meta_order_invalid_hint", limit=ORDER_ABS_MAX),
            )
        number = int(value)
        if abs(number) > ORDER_ABS_MAX:
            raise ToolError(
                tr("capsules.meta_order_invalid"),
                hint=tr("capsules.meta_order_invalid_hint", limit=ORDER_ABS_MAX),
            )
        return number
    text = str(value).strip()
    if not text:
        return None
    if field == "title":
        return text[:TITLE_MAX]
    if field == "description":
        return text[:DESCRIPTION_MAX]
    # icon: an emoji / short label, an inlined data: image, or an https: URL. Nothing else reaches
    # the <img src> / text slot in the UI, so script-ish and http: values are refused here.
    if text.startswith("data:image/"):
        if len(text) > ICON_MAX:
            raise ToolError(
                tr("capsules.meta_icon_too_large", limit=ICON_MAX // 1024),
                hint=tr("capsules.meta_icon_too_large_hint"),
            )
        return text
    if text.startswith("https://"):
        return text[:2048]
    if ":" in text or len(text) > 16:
        raise ToolError(
            tr("capsules.meta_icon_invalid", value=repr(text[:40])),
            hint=tr("capsules.meta_icon_invalid_hint"),
        )
    return text


def validate_patch(meta: dict[str, Any] | None) -> dict[str, Any]:
    """Check an incoming overlay patch **before** anything is written (import writes the file first).

    A rejected field must not leave a half-done import behind: the caller validates here, and only a
    fully valid patch reaches `set_meta`.
    """
    if not meta:
        return {}
    if not isinstance(meta, dict):
        raise ToolError(tr("capsules.meta_body_invalid"), hint=tr("capsules.meta_body_invalid_hint"))
    if meta.get("reset"):
        return {"reset": True}
    checked: dict[str, Any] = {}
    for field in _META_FIELDS:
        if field not in meta:
            continue
        _clean_field(field, meta[field])  # raises ToolError on a bad value
        checked[field] = meta[field]
    return checked


def set_meta(relpath: str, patch: dict[str, Any], *, valid: set[str] | None = None) -> dict[str, Any]:
    """Merge `patch` into one capsule's overlay entry. `None`/`""` clears a field, `{"reset": true}` the whole entry.

    `valid` (relpaths that still exist) prunes orphans in the same write: the manifest follows the
    files, it never outlives them.
    """
    relpath = str(relpath or "").strip().strip("/")
    if not relpath:
        raise ToolError(tr("capsules.meta_missing_relpath"), hint=tr("capsules.meta_missing_relpath_hint"))
    meta = read_meta()
    current = dict(meta.get(relpath) or {})
    if patch.get("reset"):
        current = {}
    else:
        for field in _META_FIELDS:
            if field not in patch:
                continue
            value = _clean_field(field, patch[field])
            if value is None:
                current.pop(field, None)
            else:
                current[field] = value
    if current:
        meta[relpath] = current
    else:
        meta.pop(relpath, None)
    if valid is not None:
        meta = {k: v for k, v in meta.items() if k in valid}
    _write_doc(meta)
    return current


def drop_meta(relpath: str) -> None:
    """Forget one capsule's overlay (used when the capsule itself is deleted)."""
    meta = read_meta()
    if meta.pop(str(relpath).strip().strip("/"), None) is not None:
        _write_doc(meta)


def apply_overlay(entries: list[dict[str, Any]]) -> tuple[int, int]:
    """Merge the overlay into scanned entries **in place**; return `(entries decorated, declared total)`.

    The difference between the two numbers is how many overlay entries decorate nothing any more
    (their file is gone) — reported as `stale_metadata` by the list.

    Effective values land in `title` / `icon` / `description` (so every existing consumer keeps
    working); the raw declared fields land in `meta`, which is what the editor reads to know which
    fields are overrides and which are scraped.
    """
    meta = read_meta()
    seen = 0
    for entry in entries:
        declared = meta.get(entry["relpath"])
        entry["meta"] = dict(declared) if declared else {}
        if not declared:
            continue
        seen += 1
        for field in ("title", "icon", "description"):
            if declared.get(field):
                entry[field] = declared[field]
    return seen, len(meta)


def sort_key(entry: dict[str, Any]) -> tuple[int, str]:
    """List order: declared `order` first (lower wins), then relpath — deterministic, layer-independent."""
    declared = (entry.get("meta") or {}).get("order")
    order = declared if isinstance(declared, int) else ORDER_FALLBACK
    return (order, str(entry.get("relpath", "")).lower())


# ------------------------------------------------------------------ import


def safe_filename(name: str) -> str:
    """Any user-supplied name → one safe `.html` / `.htm` file name (never a path)."""
    base = os.path.basename(str(name or "").strip().replace("\\", "/"))
    base = _BAD_NAME.sub("", base).strip().strip(".")
    stem, ext = os.path.splitext(base)
    if ext.lower() not in _IMPORT_SUFFIXES:
        raise ToolError(
            tr("capsules.import_suffix", name=repr(base[:60]), allowed=" / ".join(_IMPORT_SUFFIXES)),
            hint=tr("capsules.import_suffix_hint"),
        )
    stem = stem.strip()[: _NAME_MAX] or "capsule"
    return f"{stem}{ext.lower()}"


def _unique_name(root: Path, name: str) -> str:
    """`foo.html` taken → `foo-2.html`, … up to 100, then give up with a readable error."""
    if not (root / name).exists():
        return name
    stem, ext = os.path.splitext(name)
    for i in range(2, 101):
        candidate = f"{stem}-{i}{ext}"
        if not (root / candidate).exists():
            return candidate
    raise ToolError(
        tr("capsules.import_name_taken", name=name),
        hint=tr("capsules.import_name_taken_hint"),
    )


def import_entry(
    *,
    filename: str,
    content: bytes,
    replace: bool = False,
    meta: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Write one capsule file into the user library; returns what the caller reports back.

    The library is created on demand (`_user_capsules_dir_auto`, which also stores `capsules_dir`), so
    "import" is the zero-configuration path: nothing has to be set up first.
    """
    from . import capsules as C

    meta = validate_patch(meta)
    if len(content) > C.MAX_BYTES:
        raise ToolError(
            tr("capsules.file_too_large", limit=C.MAX_BYTES // (1024 * 1024)),
            hint=tr("capsules.import_too_large_hint"),
        )
    if not content:
        raise ToolError(tr("capsules.import_empty"), hint=tr("capsules.import_empty_hint"))
    try:
        root = C._user_capsules_dir_auto()
    except OSError as exc:
        raise ToolError(
            tr("capsules.import_failed", error=exc),
            hint=tr("capsules.import_failed_hint"),
        ) from exc

    name = safe_filename(filename)
    replaced = False
    target = root / name
    if target.exists():
        if target.is_dir():
            raise ToolError(
                tr("capsules.import_name_taken", name=name),
                hint=tr("capsules.import_name_taken_hint"),
            )
        if replace:
            replaced = True
        else:
            name = _unique_name(root, name)
            target = root / name
    if sum(1 for p in root.rglob("*") if p.suffix.lower() in _IMPORT_SUFFIXES) >= C.MAX_APPS:
        raise ToolError(
            tr("capsules.too_many_capsules", limit=C.MAX_APPS),
            hint=tr("capsules.too_many_capsules_hint"),
        )
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        C._write_atomic(target, content)
    except OSError as exc:
        raise ToolError(
            tr("capsules.import_failed", error=exc),
            hint=tr("capsules.import_failed_hint"),
        ) from exc
    if meta:
        set_meta(name, meta)
    return {
        "ok": True,
        "relpath": name,
        "path": str(target),
        "capsules_dir": str(root),
        "bytes": len(content),
        "replaced": replaced,
    }


def import_from_path(source: str, *, replace: bool = False, meta: dict[str, Any] | None = None) -> dict[str, Any]:
    """Import from a path already on disk (desktop: the shell's file picker returns a path).

    A file that already lives **inside the user library** is not copied at all — it is already a
    capsule, so this only records its metadata. Copying it would produce `name-2.html` out of nothing.
    """
    from . import capsules as C

    if not source:
        raise ToolError(tr("capsules.import_path_missing"), hint=tr("capsules.import_path_missing_hint"))
    meta = validate_patch(meta)
    path = Path(source).expanduser()
    try:
        path = path.resolve(strict=True)
    except OSError as exc:
        raise ToolError(
            tr("capsules.import_path_missing", path=str(path)),
            hint=tr("capsules.import_path_missing_hint"),
        ) from exc
    if not path.is_file():
        raise ToolError(
            tr("capsules.import_path_missing", path=str(path)),
            hint=tr("capsules.import_path_missing_hint"),
        )
    user = C.capsules_dir()
    if user is not None and C._inside(user.resolve(), path):
        relpath = path.relative_to(user.resolve()).as_posix()
        if path.suffix.lower() not in _IMPORT_SUFFIXES or relpath.startswith("."):
            raise ToolError(
                tr("capsules.import_suffix", name=repr(path.name), allowed=" / ".join(_IMPORT_SUFFIXES)),
                hint=tr("capsules.import_suffix_hint"),
            )
        if meta:
            set_meta(relpath, meta)
        return {
            "ok": True,
            "relpath": relpath,
            "path": str(path),
            "capsules_dir": str(user),
            "bytes": path.stat().st_size,
            "replaced": False,
            "unchanged": True,
        }
    try:
        content = path.read_bytes()
    except OSError as exc:
        raise ToolError(
            tr("capsules.import_failed", error=exc),
            hint=tr("capsules.import_failed_hint"),
        ) from exc
    return import_entry(filename=path.name, content=content, replace=replace, meta=meta)


# ------------------------------------------------------------------ delete


def delete_entry(relpath: str, *, remove_data: bool = False) -> dict[str, Any]:
    """Delete one capsule from the **user** library (the entry file, or its whole folder).

    The counterpart of the entry-path `DELETE` gate in `capsules.py` (a capsule may never delete
    itself): here the library owner does, through `/api/capsules/delete`.

      * a top-level loose file → unlink it (`remove_data` is meaningless: its folder is the library)
      * a directory capsule (`hello/index.html`) → `remove_data=False` unlinks just the entry,
        leaving the capsule's data files on disk; `remove_data=True` removes the folder
      * a bundled (system-layer) capsule is refused with a hint to disable it instead — the software
        owns that file and an upgrade replaces it
    """
    from . import capsules as C

    relpath = str(relpath or "").strip().strip("/")
    if not relpath:
        raise ToolError(tr("capsules.meta_missing_relpath"), hint=tr("capsules.meta_missing_relpath_hint"))
    user = C.capsules_dir()
    if user is None or not user.is_dir():
        raise ToolError(tr("capsules.delete_no_library"), hint=tr("capsules.delete_no_library_hint"))
    root = user.resolve()
    entry = C._resolve_in(root, relpath)
    if entry is None or not entry.is_file() or not C._inside(root, entry):
        if C._resolve(relpath) is not None:
            raise ToolError(
                tr("capsules.delete_system_entry", path=relpath),
                hint=tr("capsules.delete_system_entry_hint"),
            )
        raise ToolError(tr("capsules.not_found", path=relpath), hint=tr("capsules.not_found_layers_hint", roots=str(root)))
    rel = entry.relative_to(root).as_posix()
    folder = entry.parent
    folder_capsule = folder != root and C._inside(root, folder)
    removed: list[str] = []
    try:
        if remove_data and folder_capsule:
            shutil.rmtree(folder)
            removed.append(folder.relative_to(root).as_posix() + "/")
        else:
            entry.unlink()
            removed.append(rel)
    except OSError as exc:
        raise ToolError(tr("capsules.delete_failed", error=exc), hint=tr("capsules.delete_failed_hint")) from exc
    drop_meta(rel)
    # Disabled-list hygiene: a deleted capsule must not leave its identifier behind
    try:
        from .settings import read_value, read_settings, set_values

        key = C._scope_key(rel) or rel
        dis = read_value(read_settings()[0], "capsules_disabled")
        if isinstance(dis, list):
            keep = [
                x
                for x in dis
                if str(x).strip() not in {rel, key, entry.name, f"user:{rel}", f"user:{key}"}
            ]
            if len(keep) != len(dis):
                set_values({"capsules_disabled": keep})
    except Exception:  # noqa: BLE001 — cleanup only, never fail a completed delete
        pass
    return {
        "ok": True,
        "relpath": rel,
        "removed": removed,
        "kept_data": bool(folder_capsule and not remove_data),
    }
