"""离线验收：manifest v2、registry catalog、archive 安装、lock 记录、GitHub spec 解析。

不访问网络：registry 与插件归档都用 file:// 临时文件。
"""
from __future__ import annotations

import io
import json
import os
import sys
import tarfile
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
TMP = Path(tempfile.mkdtemp(prefix="yhub-plugin-install-"))
os.environ["YHUB_CONFIG_DIR"] = str(TMP / "config")
os.environ.setdefault("YHUB_LANG", "zh-CN")

from yhub.server.adapters import plugin_manager as pm  # noqa: E402
from yhub.server.adapters import settings as st  # noqa: E402

passed = failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global passed, failed
    if ok:
        passed += 1
        print(f"PASS  {name}")
    else:
        failed += 1
        print(f"FAIL  {name}  {detail}")


def make_plugin(version: str = "1.0.0", min_yhub: str = "0.1.0") -> Path:
    d = TMP / "src" / "regdemo"
    d.mkdir(parents=True, exist_ok=True)
    (d / "plugin.json").write_text(json.dumps({
        "schema": 2, "id": "regdemo", "name": "注册表示例", "icon": "plugin",
        "description": "离线验收用", "trust": "full", "kind": "third-party",
        "version": version, "min_yhub": min_yhub, "author": "test",
    }, ensure_ascii=False), encoding="utf-8")
    (d / "plugin.py").write_text("TOOL_META = {}\n", encoding="utf-8")
    return d


def make_tar(src: Path) -> Path:
    out = TMP / "regdemo.tar.gz"
    with tarfile.open(out, "w:gz") as tf:
        tf.add(src, arcname="regdemo")
    return out


def main() -> int:
    src = make_plugin()
    archive = make_tar(src)
    registry = TMP / "registry.json"
    registry.write_text(json.dumps({
        "schema": 1,
        "plugins": [{
            "id": "regdemo", "name": "注册表示例", "description": "离线验收用",
            "version": "1.0.0", "archive": archive.as_uri(),
        }],
    }, ensure_ascii=False), encoding="utf-8")
    st.set_values({"plugins_registry_url": str(registry)})

    rows = pm.catalog()
    check("catalog 读到 registry 条目", len(rows) == 1 and rows[0]["id"] == "regdemo", repr(rows))
    check("catalog 初始未安装", rows[0]["installed"] is False)

    result = pm.install_spec("regdemo", force=True)
    check("registry archive 安装成功", result["id"] == "regdemo" and result["source"] == "registry", repr(result))
    dest = pm.L.plugins_dir() / "regdemo"
    check("插件文件落盘", (dest / "plugin.json").is_file() and (dest / "plugin.py").is_file())
    lock = pm.read_lock()["plugins"].get("regdemo") or {}
    check("lock 记录来源/版本/sha", lock.get("source") == "registry" and lock.get("version") == "1.0.0" and bool(lock.get("sha256")), repr(lock))
    rows = pm.catalog()
    check("catalog 安装后标记已装", rows[0]["installed"] is True and rows[0]["installed_version"] == "1.0.0", repr(rows[0]))
    from yhub.server.adapters import discover_adapters
    ids = {e["meta"]["id"] for e in discover_adapters()}
    check("manifest v2 插件能被加载器发现", "regdemo" in ids, repr(ids))
    listed = {row["id"]: row for row in pm.list_plugins()}
    check("list_plugins 带 version/source", listed["regdemo"].get("version") == "1.0.0" and listed["regdemo"].get("source") == "registry", repr(listed.get("regdemo")))

    pm.remove_plugin("regdemo")
    check("卸载后目录与 lock 都清掉", not dest.exists() and "regdemo" not in (pm.read_lock()["plugins"]))

    # ---- 装/卸/启停必须让**正在运行**的宿主重建注册表（GUI 的工具表与路由不再冻在启动那一刻）----
    # 症状：从设置页卸掉插件后，侧栏还留着一个「这个工具还没有面板」的幽灵。
    from yhub.server.adapters import discover_adapters, on_registry_change

    calls: list[str] = []
    on_registry_change(lambda: calls.append("rebuild") or True)
    calls.clear()
    result = pm.install_spec(str(src), force=True)
    check("安装后通知宿主重建（工具表 + 路由），且不需要重启",
          calls == ["rebuild"] and result["restart_required"] is False, f"{calls} {result!r}")
    calls.clear()
    pm.set_enabled("regdemo", False)
    check("启/停也通知宿主重建（禁用一个插件要连同三面一起收起）", calls == ["rebuild"], repr(calls))
    pm.set_enabled("regdemo", True)
    calls.clear()
    pm.remove_plugin("regdemo")
    check("卸载后通知宿主重建（侧栏里不能再留幽灵条目）", calls == ["rebuild"], repr(calls))

    def status_of(plugin_id: str) -> str:
        for entry in discover_adapters():
            if entry["meta"]["id"] == plugin_id:
                fn = entry["meta"].get("status")
                return fn() if callable(fn) else str(fn)
        return ""

    (src / "plugin.py").write_text('TOOL_META = {"status": lambda: "v1"}\n', encoding="utf-8")
    pm.install_spec(str(src), force=True)
    check("重装同一版本也重新载入代码（缓存键不只认路径）", status_of("regdemo") == "v1", status_of("regdemo"))
    (src / "plugin.py").write_text('TOOL_META = {"status": lambda: "v2"}\n', encoding="utf-8")
    pm.install_spec(str(src), force=True)
    check("插件更新后载入的是新代码（无需重启后端）", status_of("regdemo") == "v2", status_of("regdemo"))

    # 宿主没能重建（声明冲突导致上一份工具表被沿用）时，restart_required 必须说实话
    on_registry_change(lambda: False)
    result = pm.install_spec(str(src), force=True)
    check("宿主重建失败时如实报 restart_required", result["restart_required"] is True, repr(result))
    pm.remove_plugin("regdemo")

    # 兼容性门禁
    bad = make_plugin(version="9.0.0", min_yhub="99.0.0")
    bad_archive = make_tar(bad)
    registry.write_text(json.dumps({"schema": 1, "plugins": [{
        "id": "regdemo", "name": "注册表示例", "version": "9.0.0", "archive": bad_archive.as_uri(),
    }]}, ensure_ascii=False), encoding="utf-8")
    try:
        pm.install_spec("regdemo", force=True)
    except pm.PluginError as exc:
        check("min_yhub 不满足时拒绝安装", "需要 yhub" in exc.message, exc.message)
    else:
        check("min_yhub 不满足时拒绝安装", False, "竟然装上了")

    gh = pm.parse_github_spec("owner/repo@v1.2.3#sub/dir")
    check("GitHub spec 解析 tag + subdir", gh == {"owner": "owner", "repo": "repo", "ref": "v1.2.3", "subdir": "sub/dir"}, repr(gh))
    check("GitHub URL 解析", pm.parse_github_spec("https://github.com/owner/repo")["repo"] == "repo")
    check("普通 id 不当 GitHub", pm.parse_github_spec("zdic") is None)

    print(f"\n{passed}/{passed + failed} 通过")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    finally:
        import shutil
        shutil.rmtree(TMP, ignore_errors=True)
