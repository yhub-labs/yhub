#!/usr/bin/env bash
# Version consistency: Python package / web / capsule / Tauri shell / Cargo lock.
# The single source of truth is yhub/__init__.py; the others are build manifests that are easy to miss.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$(command -v python3)"

"$PY" - "$ROOT" <<'PY'
import json, pathlib, re, sys

root = pathlib.Path(sys.argv[1])
py = re.search(r'__version__\s*=\s*"([^"]+)"', (root / "yhub/__init__.py").read_text()).group(1)
web = json.loads((root / "web/package.json").read_text())["version"]
web_lock = json.loads((root / "web/package-lock.json").read_text())
capsule = json.loads((root / "capsule-src/hello/package.json").read_text())["version"]
capsule_lock = json.loads((root / "capsule-src/hello/package-lock.json").read_text())
cargo = re.search(r'^version\s*=\s*"([^"]+)"', (root / "tauri/Cargo.toml").read_text(), re.M).group(1)
cargo_lock = re.search(
    r'\[\[package\]\]\nname = "yhub"\nversion = "([^"]+)"',
    (root / "tauri/Cargo.lock").read_text(),
).group(1)
tauri = json.loads((root / "tauri/tauri.conf.json").read_text())["version"]
min_backend = re.search(
    r'MIN_BACKEND_VERSION: &str = "([^"]+)"',
    (root / "tauri/src/backend.rs").read_text(),
).group(1)
rows = [
    ("yhub/__init__.py", py),
    ("web/package.json", web),
    ("web/package-lock.json", web_lock["version"]),
    ("web/package-lock.json packages[\"\"]", web_lock["packages"][""]["version"]),
    ("capsule-src/hello/package.json", capsule),
    ("capsule-src/hello/package-lock.json", capsule_lock["version"]),
    ("capsule-src/hello/package-lock.json packages[\"\"]", capsule_lock["packages"][""]["version"]),
    ("tauri/Cargo.toml", cargo),
    ("tauri/Cargo.lock", cargo_lock),
    ("tauri/tauri.conf.json", tauri),
    ("tauri/src/backend.rs MIN_BACKEND_VERSION", min_backend),
]
bad = [(name, value) for name, value in rows if value != py]
for name, value in rows:
    print(f"{'PASS' if value == py else 'FAIL'}  {name}: {value}")
if bad:
    print(f"\n版本号不一致（真源 {py}）：{bad}")
    sys.exit(1)
print(f"\n版本一致：{py}")
PY
