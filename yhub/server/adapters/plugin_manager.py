"""Plugin management: install/uninstall and enable/disable (backs ``yhub plugin``; also called by
install/CI scripts).

Classification:

  * **core plugins** — ship with the software, **disable-able, never removable**. They are the built-in
    adapters (``yhub/server/adapters/*.py``): they are packed into the wheel, so `plugin remove` cannot
    reach them — "not removable" is not enforced by a flag but by **them living outside the installable
    directory**.
  * **non-core (third-party)** — live in ``plugins/<id>/`` under the config root, installable and
    removable. Installs come from a registry entry, a GitHub repository/tarball, or a local path.

What the commands do:

  * ``install``: copy an install source **whole** into ``plugins/<id>/`` (manifest validated first —
                 installing a broken plugin just means a red startup); refuses when already installed
                 (use an explicit ``--force`` to replace).
  * ``remove`` : delete ``plugins/<id>/``; core plugins are refused. That plugin's config
                 (``plugins.<id>.*``) is **kept** by default; ``--purge`` clears it too.
  * ``enable`` / ``disable``: write ``plugins.<id>._enabled`` (same semantics in all three entry points).

Why this does not live in ``yhub/server/adapters/``: it reads and writes the filesystem and the config,
which is **host capability**, while ``faces`` is for tools. The CLI host commands (completion/gui/mcp)
sit at the same level.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import re
import shutil
import tarfile
import tempfile
import time
import zipfile
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import Request, urlopen

from yhub.i18n import current_lang, tr, tr_text

from . import _plugin_loader as L


class PluginError(Exception):
    """User-facing error: translated into human text (with a hint) by the CLI."""

    def __init__(self, message: str, *, hint: str = "") -> None:
        super().__init__(message)
        self.message = message
        self.hint = hint


def _notify_registry_changed() -> bool:
    """The installed plugin set / enable state changed → the running host must rebuild its registry.

    Otherwise `/api/tools` and the routes stay the snapshot taken at startup: an uninstalled plugin's
    tool kept sitting in the sidebar as "this tool has no panel yet", and a fresh install had no
    working routes. Returns True when the change is already live (no restart needed).

    The import is local because ``adapters/__init__`` is the package this module lives in (top-level
    would be fine but the cycle is one edit away from biting).
    """
    from . import notify_registry_change  # noqa: PLC0415

    return notify_registry_change()


# ----------------------------------------------------- install sources / lock / registry

LOCK_SCHEMA = 1
MAX_ARCHIVE_BYTES = 32 * 1024 * 1024
MAX_ARCHIVE_FILES = 5000
_USER_AGENT = "yhub-plugin-installer/1 (+https://github.com/yhub-labs/yhub)"


def _config_dir() -> Path:
    from .settings import config_dir

    return config_dir()


def lock_path() -> Path:
    return _config_dir() / "plugins.lock.json"


def read_lock() -> dict:
    try:
        raw = json.loads(lock_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"schema": LOCK_SCHEMA, "plugins": {}}
    if not isinstance(raw, dict) or not isinstance(raw.get("plugins"), dict):
        return {"schema": LOCK_SCHEMA, "plugins": {}}
    return raw


def _write_lock(data: dict) -> None:
    path = lock_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    data["schema"] = LOCK_SCHEMA
    payload = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        tmp.write_text(payload, encoding="utf-8")
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink(missing_ok=True)


def _record_install(plugin_id: str, **fields) -> None:
    data = read_lock()
    current = data["plugins"].get(plugin_id) or {}
    data["plugins"][plugin_id] = {**current, **fields, "installed_at": int(time.time())}
    _write_lock(data)


def _forget_install(plugin_id: str) -> None:
    data = read_lock()
    if data["plugins"].pop(plugin_id, None) is not None:
        _write_lock(data)


def _read_url(url: str) -> bytes:
    """Read a registry / archive (supports http(s), file:// and local paths)."""
    if url.startswith("file://"):
        return Path(urlsplit(url).path).read_bytes()
    if url.startswith(("http://", "https://")):
        req = Request(url, headers={"User-Agent": _USER_AGENT, "Accept": "*/*"})
        try:
            with urlopen(req, timeout=25) as resp:
                data = resp.read(MAX_ARCHIVE_BYTES + 1)
        except (HTTPError, URLError, TimeoutError) as exc:
            raise PluginError(tr("plugins.err.download_failed", url=url, reason=exc),
                              hint=tr("plugins.err.hint_download")) from exc
        if len(data) > MAX_ARCHIVE_BYTES:
            raise PluginError(tr("plugins.err.download_too_large",
                                 limit=MAX_ARCHIVE_BYTES // (1024 * 1024), url=url))
        return data
    return Path(url).expanduser().read_bytes()


def _read_json_url(url: str) -> dict:
    try:
        data = json.loads(_read_url(url).decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise PluginError(tr("plugins.err.not_json", url=url),
                          hint=tr("plugins.err.hint_registry_json")) from exc
    if not isinstance(data, dict):
        raise PluginError(tr("plugins.err.top_level_not_object", url=url))
    return data


def registry_url() -> str:
    try:
        from .settings import read_settings

        return str(read_settings()[0].get("plugins_registry_url") or "").strip()
    except Exception:  # noqa: BLE001
        return ""


def _registry_cache_path() -> Path:
    return _config_dir() / "plugins-registry-cache.json"


def _normalize_registry(data: dict) -> list[dict]:
    if data.get("schema") != 1 or not isinstance(data.get("plugins"), list):
        raise PluginError(tr("plugins.err.registry_format"),
                          hint=tr("plugins.err.hint_registry_schema"))
    out: list[dict] = []
    for item in data["plugins"]:
        if not isinstance(item, dict):
            continue
        pid = item.get("id")
        if not isinstance(pid, str) or not L._ID_RE.match(pid):  # noqa: SLF001
            continue
        repo = item.get("repo") if isinstance(item.get("repo"), str) else ""
        archive = item.get("archive") if isinstance(item.get("archive"), str) else ""
        pypi = item.get("pypi") if isinstance(item.get("pypi"), str) else ""
        if not (repo or archive or pypi):
            continue
        out.append({
            **item,
            "id": pid,
            "name": _pick_lang(item, "name", pid),
            "description": _pick_lang(item, "description", ""),
            "author": str(item.get("author") or ""),
            "version": str(item.get("version") or ""),
            "repo": repo,
            "archive": archive,
            "pypi": pypi,
            "subdir": str(item.get("subdir") or ""),
            "ref": str(item.get("ref") or ""),
            "min_yhub": str(item.get("min_yhub") or ""),
        })
    return out


def _pick_lang(item: dict, field: str, default: str) -> str:
    """Registry metadata is bilingual: `name`/`description` are English, `name_zh`/`description_zh`
    are optional Chinese overrides. Registry entries are fetched, never installed, so they cannot use
    the `locales/` mechanism — two explicit fields keep the JSON readable in a diff."""
    if current_lang() == "zh-CN":
        zh = item.get(f"{field}_zh")
        if isinstance(zh, str) and zh.strip():
            return zh
    return str(item.get(field) or default)


def fetch_registry(*, refresh: bool = False) -> list[dict]:
    url = registry_url()
    if not url:
        raise PluginError(
            tr("plugins.err.registry_not_configured"),
            hint=tr("plugins.err.hint_set_registry"),
        )
    cache = _registry_cache_path()
    cached: list[dict] | None = None
    try:
        raw = json.loads(cache.read_text(encoding="utf-8"))
        if isinstance(raw, dict) and raw.get("url") == url and isinstance(raw.get("plugins"), list):
            cached = raw["plugins"]
            fetched_at = int(raw.get("fetched_at") or 0)
            if not refresh and time.time() - fetched_at < 300:
                return cached
    except (OSError, ValueError):
        cached = None
    try:
        entries = _normalize_registry(_read_json_url(url))
    except PluginError:
        if cached is not None:
            return cached
        raise
    try:
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps({"url": url, "fetched_at": int(time.time()), "plugins": entries},
                                    ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except OSError:
        pass
    return entries


def registry_entry(plugin_id: str) -> dict:
    for entry in fetch_registry():
        if entry["id"] == plugin_id:
            return entry
    raise PluginError(tr("plugins.err.not_in_registry", id=plugin_id),
                      hint=tr("plugins.err.hint_plugin_search"))


def catalog(query: str = "", refresh: bool = False) -> list[dict]:
    """Plugin marketplace: registry entries + local install state/version."""
    installed = _installed_ids()
    lock = read_lock().get("plugins") or {}
    q = query.strip().lower()
    out: list[dict] = []
    for entry in fetch_registry(refresh=refresh):
        hay = " ".join(str(entry.get(k, "")) for k in ("id", "name", "description", "author")).lower()
        if q and q not in hay:
            continue
        pid = entry["id"]
        manifest = None
        if pid in installed:
            try:
                manifest = _manifest_of(installed[pid])
            except (PluginError, ValueError):
                manifest = None
        installed_version = (manifest or {}).get("version") or (lock.get(pid) or {}).get("version") or ""
        latest = entry.get("version") or ""
        out.append({
            **entry,
            "installed": pid in installed,
            "installed_version": installed_version,
            "update_available": bool(
                installed_version and latest and L.version_lt(installed_version, latest)
            ),
            "source": (lock.get(pid) or {}).get("source") or ("config" if pid in installed else ""),
        })
    return out


# ---------------------------------------------------------------- GitHub / archive


_GITHUB_SPEC_RE = re.compile(
    r"^(?:github:)?([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\.git)?(?:@([^#]+))?(?:#(.+))?$"
)
_GITHUB_URL_RE = re.compile(
    r"^https?://github\.com/([A-Za-z0-9_.-]+)/([^/#?]+?)(?:\.git)?"
    r"(?:/(?:tree|releases/tag)/([^/#?]+))?(?:#(.+))?(?:\?.*)?$"
)


def parse_github_spec(spec: str) -> dict | None:
    spec = spec.strip()
    m = _GITHUB_URL_RE.match(spec)
    if m:
        return {"owner": m.group(1), "repo": m.group(2), "ref": m.group(3) or "", "subdir": m.group(4) or ""}
    m = _GITHUB_SPEC_RE.match(spec)
    if not m:
        return None
    return {"owner": m.group(1), "repo": m.group(2), "ref": m.group(3) or "", "subdir": m.group(4) or ""}


def _http_json(url: str) -> dict:
    data = _read_url(url)
    try:
        parsed = json.loads(data.decode("utf-8"))
    except ValueError as exc:
        raise PluginError(tr("plugins.err.github_not_json", url=url)) from exc
    if not isinstance(parsed, dict):
        raise PluginError(tr("plugins.err.github_bad_format", url=url))
    return parsed


def _github_ref(owner: str, repo: str, requested: str = "") -> str:
    if requested:
        return requested
    try:
        latest = _http_json(f"https://api.github.com/repos/{owner}/{repo}/releases/latest")
        if latest.get("tag_name"):
            return str(latest["tag_name"])
    except PluginError:
        pass
    try:
        info = _http_json(f"https://api.github.com/repos/{owner}/{repo}")
        if info.get("default_branch"):
            return str(info["default_branch"])
    except PluginError:
        pass
    return "main"


def _github_manifest_version(owner: str, repo: str) -> str:
    try:
        raw = _read_json_url(f"https://raw.githubusercontent.com/{owner}/{repo}/HEAD/plugin.json")
        return str(raw.get("version") or "")
    except PluginError:
        return ""


def _safe_relative(name: str) -> str | None:
    normalized = name.replace("\\", "/")
    parts = [p for p in normalized.split("/") if p not in ("", ".")]
    if not parts or any(p == ".." for p in parts):
        return None
    return "/".join(parts)


def _extract_archive(blob: bytes, filename: str, dest: Path) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    count = 0
    total = 0
    if filename.endswith(".zip") or blob[:2] == b"PK":
        with zipfile.ZipFile(io.BytesIO(blob)) as zf:
            for info in zf.infolist():
                if info.is_dir():
                    continue
                if (info.external_attr >> 16) & 0o170000 == 0o120000:
                    raise PluginError(tr("plugins.err.archive_symlink"))
                rel = _safe_relative(info.filename)
                if rel is None:
                    raise PluginError(tr("plugins.err.archive_unsafe_path", path=info.filename))
                total += info.file_size
                count += 1
                if total > MAX_ARCHIVE_BYTES or count > MAX_ARCHIVE_FILES:
                    raise PluginError(tr("plugins.err.archive_too_large"))
                target = dest / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(info) as src, open(target, "wb") as out:
                    shutil.copyfileobj(src, out)
        return
    try:
        tf = tarfile.open(fileobj=io.BytesIO(blob), mode="r:*")
    except tarfile.TarError as exc:
        raise PluginError(tr("plugins.err.archive_unknown", reason=exc)) from exc
    with tf:
        for member in tf:
            if member.isdir():
                continue
            if not member.isfile():
                raise PluginError(tr("plugins.err.archive_special_file"))
            rel = _safe_relative(member.name)
            if rel is None:
                raise PluginError(tr("plugins.err.archive_unsafe_path", path=member.name))
            total += member.size
            count += 1
            if total > MAX_ARCHIVE_BYTES or count > MAX_ARCHIVE_FILES:
                raise PluginError(tr("plugins.err.archive_too_large"))
            src = tf.extractfile(member)
            if src is None:
                continue
            target = dest / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            with src, open(target, "wb") as out:
                shutil.copyfileobj(src, out)


def _find_plugin_root(extract: Path, subdir: str = "") -> Path:
    tops = [p for p in extract.iterdir() if p.is_dir()]
    top = tops[0] if len(tops) == 1 else extract
    if subdir:
        root = top.joinpath(*[p for p in subdir.split("/") if p])
        if (root / "plugin.json").is_file():
            return root
        raise PluginError(tr("plugins.err.archive_subdir_missing", subdir=subdir))
    if (top / "plugin.json").is_file():
        return top
    for child in sorted(top.iterdir()):
        if child.is_dir() and (child / "plugin.json").is_file():
            return child
    raise PluginError(tr("plugins.err.archive_no_manifest"), hint=tr("plugins.err.hint_plugin_root"))


def _copy_plugin_tree(root: Path, plugin_id: str, *, force: bool) -> dict:
    raw = json.loads((root / "plugin.json").read_text(encoding="utf-8"))
    if not isinstance(raw, dict) or raw.get("id") != plugin_id:
        raise PluginError(tr("plugins.err.manifest_id_mismatch", id=plugin_id))
    dest = L.plugins_dir() / plugin_id
    if dest.exists() and not force:
        raise PluginError(tr("plugins.err.already_installed", id=plugin_id),
                          hint=tr("plugins.err.hint_force"))
    _config_dir().mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix=".plugin-install-", dir=str(_config_dir())))
    staging = work / plugin_id
    ignore = shutil.ignore_patterns(".git", ".github", "__pycache__", "*.pyc", "node_modules", ".venv", "dist")
    try:
        if any(p.is_symlink() for p in root.rglob("*")):
            raise PluginError(tr("plugins.err.plugin_dir_symlink"))
        shutil.copytree(root, staging, ignore=ignore)
        manifest = _manifest_of(staging)
        if not (staging / "plugin.py").is_file():
            raise PluginError(tr("plugins.err.plugin_py_missing_id", id=plugin_id))
        L.plugins_dir().mkdir(parents=True, exist_ok=True)
        if dest.exists():
            shutil.rmtree(dest)
        staging.rename(dest)
        return manifest
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _install_archive(
    blob: bytes,
    filename: str,
    *,
    expected_id: str,
    subdir: str = "",
    force: bool = False,
    source: str = "archive",
    spec: str = "",
    repo: str = "",
    ref: str = "",
    registry_id: str = "",
    pinned: bool | None = None,
) -> dict:
    digest = hashlib.sha256(blob).hexdigest()
    _config_dir().mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix=".plugin-extract-", dir=str(_config_dir())))
    try:
        _extract_archive(blob, filename, work)
        root = _find_plugin_root(work, subdir)
        raw = json.loads((root / "plugin.json").read_text(encoding="utf-8"))
        actual_id = str(raw.get("id") or "")
        if expected_id and actual_id != expected_id:
            raise PluginError(tr("plugins.err.archive_id_mismatch", expected=expected_id,
                                 actual=actual_id or tr("plugins.word.empty")))
        plugin_id = actual_id
        manifest = _validate_manifest_for_id(raw, plugin_id)
        min_yhub = manifest.get("min_yhub")
        from yhub import __version__

        if min_yhub and L.version_lt(__version__, min_yhub):
            raise PluginError(tr("plugins.err.min_yhub", id=plugin_id, version=min_yhub,
                                 current=__version__),
                              hint=tr("plugins.err.hint_upgrade"))
        if int(manifest.get("api", 1)) > L.PLUGIN_API_VERSION:
            raise PluginError(tr("plugins.err.api_too_new", id=plugin_id,
                                 api=manifest.get('api'), supported=L.PLUGIN_API_VERSION))
        installed = _copy_plugin_tree(root, plugin_id, force=force)
        version = installed.get("version") or ""
        _record_install(
            plugin_id,
            source=source,
            spec=spec or plugin_id,
            version=version,
            repo=repo,
            ref=ref,
            registry_id=registry_id,
            sha256=digest,
            pinned=(pinned if pinned is not None else bool(spec and "@" in spec)),
        )
        return {"id": plugin_id, "version": version, "source": source, "ref": ref,
                "sha256": digest, "restart_required": True}
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _validate_manifest_for_id(raw: dict, plugin_id: str) -> dict:
    """Validate against the target id (directory names inside a downloaded archive are unreliable, so
    validate by id first)."""
    _config_dir().mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix=".plugin-validate-", dir=str(_config_dir())))
    tmp = work / plugin_id
    try:
        tmp.mkdir(parents=True, exist_ok=True)
        (tmp / "plugin.json").write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
        # `tmp` holds only plugin.json: file-presence checks belong to the installed directory, not here.
        return L._validate_manifest(raw, tmp, check_files=False)  # noqa: SLF001
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _install_github(
    parsed: dict,
    *,
    force: bool = False,
    ref: str = "",
    expected_id: str = "",
    source: str = "github",
    spec: str = "",
    registry_id: str = "",
) -> dict:
    owner, repo = parsed["owner"], parsed["repo"]
    resolved = _github_ref(owner, repo, ref or parsed.get("ref") or "")
    url = f"https://codeload.github.com/{owner}/{repo}/tar.gz/{quote(resolved, safe='')}"
    try:
        blob = _read_url(url)
    except PluginError:
        # An old repo's default branch may be master; only fall back when no explicit ref was given
        if resolved != "main" or ref or parsed.get("ref"):
            raise
        resolved = "master"
        url = f"https://codeload.github.com/{owner}/{repo}/tar.gz/master"
        blob = _read_url(url)
    return _install_archive(
        blob, f"{repo}-{resolved}.tar.gz",
        expected_id=expected_id,
        subdir=parsed.get("subdir") or "",
        force=force,
        source=source,
        spec=spec or f"{owner}/{repo}",
        repo=f"{owner}/{repo}",
        ref=resolved,
        registry_id=registry_id,
        pinned=bool(ref or parsed.get("ref")),
    )


def install_spec(spec: str, *, force: bool = False, ref: str = "", plugin_id: str | None = None) -> dict:
    """Single entry point: local directory / GitHub / registry id.

    A successful install notifies the registry hook, so the GUI picks the new plugin up **without a
    restart** (its routes are registered and its tool appears in `/api/tools`).
    """
    result = _install_spec(spec, force=force, ref=ref, plugin_id=plugin_id)
    # `restart_required` is honest, not decorative: in the GUI process the hook has already rebuilt
    # the registry (tool list + routes), so nothing needs restarting; the CLI's own process has no
    # hook, and the running GUI there still holds the previous registry.
    result["restart_required"] = not _notify_registry_changed()
    return result


def _install_spec(spec: str, *, force: bool = False, ref: str = "",
                  plugin_id: str | None = None) -> dict:
    """The install itself (see `install_spec`: same signature, no registry notification)."""
    spec = spec.strip()
    if not spec:
        raise PluginError(tr("plugins.err.spec_required"))
    if spec.startswith("pypi:"):
        raise PluginError(tr("plugins.err.pypi_phase2"),
                          hint=tr("plugins.err.hint_registry_or_github"))
    path = Path(spec).expanduser()
    if path.is_dir():
        # `plugin_id` lets a single-plugin repository be installed from its own checkout, where the
        # directory name is the repository's (`yhub-plugin-zdic`) and not the plugin's (`zdic`).
        manifest = add_plugin(path, force=force, plugin_id=plugin_id)
        _record_install(manifest["id"], source="local", spec=str(path),
                        version=manifest.get("version") or "")
        return {"id": manifest["id"], "version": manifest.get("version") or "",
                "source": "local", "restart_required": True}
    parsed = parse_github_spec(spec)
    if parsed is not None and ("/" in spec):
        return _install_github(parsed, force=force, ref=ref, spec=spec)
    entry = registry_entry(spec)
    if entry.get("archive"):
        blob = _read_url(entry["archive"])
        return _install_archive(blob, entry["archive"].split("?")[0].split("/")[-1] or "plugin.tar.gz",
                                expected_id=entry["id"], subdir=entry.get("subdir") or "",
                                force=force, source="registry", spec=spec,
                                registry_id=entry["id"], pinned=bool(entry.get("ref")))
    if entry.get("repo"):
        parsed = parse_github_spec(entry["repo"])
        if parsed is None:
            raise PluginError(tr("plugins.err.registry_repo_invalid", id=entry["id"],
                                 repo=entry["repo"]))
        return _install_github(parsed, force=force,
                               ref=entry.get("ref") or "", expected_id=entry["id"],
                               source="registry", spec=spec, registry_id=entry["id"])
    if entry.get("pypi"):
        raise PluginError(tr("plugins.err.pypi_only"),
                          hint=tr("plugins.err.hint_github_or_archive"))
    raise PluginError(tr("plugins.err.no_install_url", spec=spec))


def check_updates() -> list[dict]:
    installed = _installed_ids()
    lock = read_lock().get("plugins") or {}
    out: list[dict] = []
    for pid, meta in lock.items():
        if pid not in installed:
            continue
        source = meta.get("source")
        try:
            manifest = _manifest_of(installed[pid])
        except (PluginError, ValueError):
            continue
        current = manifest.get("version") or meta.get("version") or ""
        latest = ""
        if source == "registry":
            try:
                latest = registry_entry(pid).get("version") or ""
            except PluginError:
                latest = ""
        elif source == "github" and not meta.get("pinned"):
            repo = str(meta.get("repo") or "")
            if "/" in repo:
                owner, name = repo.split("/", 1)
                latest = _github_manifest_version(owner, name)
        elif source == "github" and meta.get("pinned"):
            continue
        out.append({
            "id": pid,
            "source": source,
            "installed_version": current,
            "latest_version": latest,
            "update_available": bool(current and latest and L.version_lt(current, latest)),
        })
    return out


def update_plugins(plugin_ids: list[str] | None = None) -> dict:
    installed = _installed_ids()
    lock = read_lock().get("plugins") or {}
    targets = plugin_ids or [p["id"] for p in check_updates() if p["update_available"]]
    updated: list[dict] = []
    skipped: list[dict] = []
    for pid in targets:
        meta = lock.get(pid)
        if pid not in installed or not meta:
            skipped.append({"id": pid, "reason": tr("plugins.skip.not_installed")})
            continue
        source = meta.get("source")
        try:
            if source == "registry":
                updated.append(install_spec(pid, force=True))
            elif source == "github":
                if meta.get("pinned"):
                    skipped.append({"id": pid, "reason": tr("plugins.skip.pinned")})
                else:
                    updated.append(install_spec(str(meta.get("repo") or ""), force=True))
            else:
                skipped.append({"id": pid, "reason": tr("plugins.skip.source", source=source)})
        except PluginError as exc:
            skipped.append({"id": pid, "reason": exc.message})
    return {"updated": updated, "skipped": skipped}


# ------------------------------------------------------------------ read-only inventory


def _manifest_of(dir_path: Path, *, allow_dir_mismatch: bool = False) -> dict:
    """Read and validate one plugin directory's manifest (no code loading: management commands need no exec)."""
    manifest_path = dir_path / "plugin.json"
    try:
        raw = json.loads(manifest_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise PluginError(tr("plugins.err.manifest_missing", dir=dir_path.name),
                          hint=tr("plugins.err.hint_plugin_dir_convention")) from None
    except json.JSONDecodeError as exc:
        raise PluginError(tr("plugins.err.manifest_not_json",
                             path=f"{dir_path.name}/plugin.json",
                             line=exc.lineno, message=exc.msg)) from None
    # Management commands never import plugin code, but they still render the manifest: resolve
    # `@key` through the plugin's own `locales/` first, so limits apply to the final text and
    # `yhub plugin list` is translated too.
    from ._plugin_i18n import prepare as _prepare_i18n

    missing = _prepare_i18n(raw, dir_path)
    if missing:
        raise PluginError(tr("plugins.err.locales_missing_keys", keys=", ".join(sorted(missing)[:6])),
                          hint=tr("plugins.err.hint_plugin_dir_convention"))
    return L._validate_manifest(raw, dir_path,  # noqa: SLF001 — validation exists once
                                allow_dir_mismatch=allow_dir_mismatch)


def _installed_ids() -> dict[str, Path]:
    root = L.plugins_dir()
    if not root.is_dir():
        return {}
    return {p.name: p for p in sorted(root.iterdir())
            if p.is_dir() and not p.name.startswith((".", "_")) and (p / "plugin.json").is_file()}


def core_ids() -> list[str]:
    """Core plugin ids = built-in adapter ids (they declare no kind and are core by construction).

    **Never filtered by the enable switch** either: a disabled core plugin must still show up in the list
    (otherwise the user could not re-enable it).
    """
    return sorted(_builtin_ids() - set(_installed_ids()))


def list_plugins() -> list[dict]:
    """State of all plugins: core + installed external."""
    enabled_map = L.read_enabled_map()
    installed = _installed_ids()
    lock = read_lock().get("plugins") or {}

    out: list[dict] = []
    for entry in _core_entries(installed):
        out.append(entry)
    for plugin_id, dir_path in installed.items():
        try:
            manifest = _manifest_of(dir_path)
        except (PluginError, ValueError) as exc:
            out.append({"id": plugin_id, "kind": "third-party", "installed": True,
                        "enabled": False, "broken": str(exc), "source": "config"})
            continue
        out.append({
            "id": plugin_id,
            "name": tr_text(manifest.get("name", plugin_id)),
            "icon": manifest.get("icon", ""),
            "description": tr_text(manifest.get("description", "")),
            "kind": manifest.get("kind", L.DEFAULT_KIND),
            "version": manifest.get("version") or "",
            "installed": True,
            "enabled": L.is_enabled(plugin_id, enabled_map),
            "uninstallable": True,
            "source": (lock.get(plugin_id) or {}).get("source") or "config",
            "repo": (lock.get(plugin_id) or {}).get("repo") or "",
            "ref": (lock.get(plugin_id) or {}).get("ref") or "",
            "pinned": bool((lock.get(plugin_id) or {}).get("pinned")),
            "disabled_file": (dir_path / "disabled").exists(),
        })
    return out


def _core_entries(installed: dict[str, Path]) -> list[dict]:
    """Built-in adapters = core plugins (disable-able, not removable).

    Uses `_iter_modules` rather than `discover_adapters`: **disabled core plugins must still be listed**
    (`enabled: false`), otherwise they vanish from the UI and can never be enabled again.
    """
    from . import _collect_meta, _iter_modules

    enabled_map = L.read_enabled_map()
    collected: list[dict] = []
    for mod in _iter_modules():
        _collect_meta(mod, collected)
    seen: set[str] = set()
    out: list[dict] = []
    for entry in collected:
        meta = entry["meta"]
        plugin_id = str(meta.get("id", ""))
        if not plugin_id or plugin_id in seen or plugin_id in installed:
            continue
        seen.add(plugin_id)
        out.append({
            "id": plugin_id,
            "name": tr_text(meta.get("name", plugin_id)),
            "icon": meta.get("icon", ""),
            "description": tr_text(meta.get("description", "")),
            "kind": "core",
            "version": "",
            "installed": True,
            "enabled": L.is_enabled(plugin_id, enabled_map),
            "uninstallable": False,
            "source": "builtin",
        })
    return out


# ------------------------------------------------------------------ install / remove


def add_plugin(source: str | Path, *, force: bool = False, plugin_id: str | None = None) -> dict:
    """Install a plugin directory into the config root."""
    src = Path(source).expanduser()
    if not src.is_dir():
        raise PluginError(
            tr("plugins.err.source_not_found", source=source),
            hint=tr("plugins.err.hint_source", where=tr("plugins.err.hint_where_no_repo")),
        )
    src = src.resolve()

    manifest = _manifest_of(src, allow_dir_mismatch=plugin_id is not None)
    pid = plugin_id or str(manifest["id"])
    if pid != src.name and plugin_id is None:
        raise PluginError(tr("plugins.err.dir_id_mismatch", dir=src.name, id=pid),
                          hint=tr("plugins.err.hint_dir_name"))

    dest = L.plugins_dir() / pid
    if dest.exists() and not force:
        raise PluginError(tr("plugins.err.already_installed", id=pid),
                          hint=tr("plugins.err.hint_force_path", path=dest))

    dest.parent.mkdir(parents=True, exist_ok=True)
    staging = dest.with_name(dest.name + ".installing")
    if staging.exists():
        shutil.rmtree(staging)
    shutil.copytree(src, staging)
    if dest.exists():
        shutil.rmtree(dest)
    staging.rename(dest)
    return {
        "id": pid,
        "installed": True,
        "path": str(dest),
        "kind": manifest.get("kind", L.DEFAULT_KIND),
        "version": manifest.get("version") or "",
        "replaced": force and dest.exists(),
    }


def remove_plugin(plugin_id: str, *, purge: bool = False) -> dict:
    """Remove a non-core plugin. Core plugins are refused (they ship with the software, disable-only)."""
    installed = _installed_ids()
    if plugin_id not in installed:
        if plugin_id in _builtin_ids():
            raise PluginError(
                tr("plugins.err.core_not_removable", id=plugin_id),
                hint=tr("plugins.err.hint_core_disable", id=plugin_id),
            )
        raise PluginError(tr("plugins.err.not_installed", id=plugin_id),
                          hint=tr("plugins.err.hint_plugin_list"))

    dest = installed[plugin_id]
    manifest_kind = None
    try:
        manifest_kind = _manifest_of(dest).get("kind", L.DEFAULT_KIND)
    except (PluginError, ValueError):
        pass
    if manifest_kind == "core":
        raise PluginError(
            tr("plugins.err.core_kind_not_removable", id=plugin_id),
            hint=tr("plugins.err.hint_core_disable", id=plugin_id),
        )

    shutil.rmtree(dest)
    _forget_install(plugin_id)
    purged = False
    if purge:
        purged = _patch_plugin_section(plugin_id, remove=True)
    # The plugin's code is gone from disk: rebuild the registry so its tool disappears from the
    # sidebar and its routes stop answering (until now both were frozen at startup).
    _notify_registry_changed()
    return {"id": plugin_id, "installed": False, "purged_config": purged, "path": str(dest)}


def _patch_plugin_section(plugin_id: str, *, remove: bool = False,
                          key: str | None = None, value: object = None) -> bool:
    """Change the ``plugins.<id>`` section of the config (other fields preserved); True on success.

    Goes through ``read_settings`` + ``read_raw``: the former gives the defaults-filled structure, the
    latter preserves fields Rust may have written and Python does not know yet — the same convention as
    ``settings.write_settings``.
    """
    from .settings import read_raw, read_settings, write_settings  # noqa: PLC0415

    settings, _warnings = read_settings()
    raw, _raw_warnings = read_raw()
    plugins = settings.setdefault("plugins", {})
    if not isinstance(plugins, dict):
        plugins = {}
        settings["plugins"] = plugins

    if remove:
        if plugin_id not in plugins:
            return False
        plugins.pop(plugin_id)
    else:
        section = plugins.get(plugin_id)
        if not isinstance(section, dict):
            section = {}
        section[key] = value
        plugins[plugin_id] = section
    write_settings(settings, raw)
    return True


def _builtin_ids() -> set[str]:
    """All built-in adapter ids (**never filtered by the enable switch**).

    This is the existence test behind `set_enabled`, so it must not reuse `discover_adapters()` — that one
    already filters by the switch. Otherwise there is a dead loop: once a plugin is disabled it can never
    be found again, and therefore never re-enabled (observed in practice).
    """
    from . import _iter_modules, _collect_meta

    adapters: list[dict] = []
    for mod in _iter_modules():
        _collect_meta(mod, adapters)
    return {str(e["meta"].get("id", "")) for e in adapters}


def set_enabled(plugin_id: str, enabled: bool) -> dict:
    """Write ``plugins.<id>._enabled`` to the config. Applies to core and external plugins alike
    (disabling a core plugin removes all three faces)."""
    if plugin_id not in _builtin_ids() and plugin_id not in _installed_ids():
        raise PluginError(tr("plugins.err.plugin_not_found", id=plugin_id),
                          hint=tr("plugins.err.hint_plugin_list_names"))

    _patch_plugin_section(plugin_id, key=L.ENABLED_KEY, value=bool(enabled))
    # Enable / disable is a registry change: a disabled plugin's faces (routes / MCP / CLI) and its
    # cells go away, so the running host has to rebuild instead of serving the startup snapshot.
    _notify_registry_changed()
    return {"id": plugin_id, "enabled": bool(enabled)}
