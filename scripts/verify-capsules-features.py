#!/usr/bin/env python3
"""验证胶囊新设计：
1. 内置胶囊支持沙盒数据持久化写入（数据落用户目录，代码保持只读以随软件自动升级）；
2. 胶囊支持界面启用与禁用（持久化、路由拦截与列表状态）。
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

# 隔离环境
tmp_dir = tempfile.TemporaryDirectory()
cfg_dir = Path(tmp_dir.name) / "config"
user_caps_dir = Path(tmp_dir.name) / "user_capsules"
sys_caps_dir = Path(tmp_dir.name) / "system_capsules"

cfg_dir.mkdir(parents=True, exist_ok=True)
sys_caps_dir.mkdir(parents=True, exist_ok=True)
user_caps_dir.mkdir(parents=True, exist_ok=True)

# 造一个系统层目录型胶囊 hello
sys_hello = sys_caps_dir / "hello"
sys_hello.mkdir(parents=True, exist_ok=True)
(sys_hello / "index.html").write_text("<!doctype html><title>Hello World</title>", encoding="utf-8")
(sys_hello / "data").mkdir(parents=True, exist_ok=True)
(sys_hello / "data" / "initial.json").write_text('{"msg": "init"}', encoding="utf-8")

os.environ["YHUB_CONFIG_DIR"] = str(cfg_dir)
os.environ["YHUB_SYSTEM_CAPSULES_DIR"] = str(sys_caps_dir)

from yhub.server.adapters import capsules
from yhub.server.adapters import settings


def run_async(coro):
    import asyncio
    return asyncio.run(coro)


def test_capsules_list():
    print("▶ 1. 验证扫描与返回字段包含 enabled 与 id")
    req = MagicMock()
    req.base_url = "http://127.0.0.1:8790"
    res = capsules.list_capsules(req)
    assert res["ok"] is True
    items = res["capsules"]
    assert len(items) >= 1
    hello_item = next(x for x in items if "hello" in x["relpath"])
    assert hello_item["source"] == "system"
    assert hello_item["enabled"] is True
    assert hello_item["data_writable"] is True
    assert "system:hello/index.html" in hello_item["id"]
    print("  ✓ 列表包含 id 与 enabled 字段")


def test_toggle_capsule():
    print("▶ 2. 验证胶囊禁用与启用")
    req_disable = MagicMock()
    req_disable.json = AsyncMock(return_value={
        "id": "system:hello/index.html",
        "enabled": False,
    })
    # 禁用
    res_dis = run_async(capsules.toggle_capsule(req_disable))
    assert res_dis["ok"] is True
    assert res_dis["enabled"] is False

    # 验证列表中的状态变为了 false
    req = MagicMock()
    req.base_url = "http://127.0.0.1:8790"
    res = capsules.list_capsules(req)
    hello_item = next(x for x in res["capsules"] if "hello" in x["relpath"])
    assert hello_item["enabled"] is False

    # 验证 _resolve 时被过滤掉（无法访问）
    assert capsules._resolve("hello/index.html") is None
    assert capsules._resolve("hello/") is None

    # 重新启用
    req_enable = MagicMock()
    req_enable.json = AsyncMock(return_value={
        "id": "system:hello/index.html",
        "enabled": True,
    })
    res_en = run_async(capsules.toggle_capsule(req_enable))
    assert res_en["ok"] is True
    assert res_en["enabled"] is True
    assert capsules._resolve("hello/index.html") is not None
    print("  ✓ 胶囊禁用与启用切换通过")


def test_system_capsule_data_persistence():
    print("▶ 3. 验证内置胶囊沙盒数据写入（持久化落盘用户库，代码保持系统层）")
    # 设置用户目录
    settings.set_values({"capsules_dir": str(user_caps_dir)})

    # 1. 读系统层自带初始数据
    hit = capsules._sandbox_resolve("hello/data/initial.json")
    assert hit is not None
    assert hit[1] == (sys_hello / "data" / "initial.json").resolve()

    # 2. 对内置胶囊发起沙盒数据写入
    put_req = MagicMock()
    put_req.headers = {"origin": "http://127.0.0.1:8790"}
    put_req.body = AsyncMock(return_value=b'{"user_saved": 123}')

    res = run_async(capsules.put_capsule("hello/data/user_note.json", put_req))
    assert res.status_code == 204, f"写入应当成功 204，实际 {res.status_code}"

    # 3. 验证数据确实写入了用户目录，而非系统层（代码/系统层只读）
    user_saved_file = user_caps_dir / "hello" / "data" / "user_note.json"
    assert user_saved_file.is_file(), f"用户目录中缺少保存的数据: {user_saved_file}"
    assert user_saved_file.read_text(encoding="utf-8") == '{"user_saved": 123}'

    # 系统层没有被写脏
    assert not (sys_hello / "data" / "user_note.json").exists()

    # 4. 读取该文件：优先读到用户目录的数据
    hit_user = capsules._sandbox_resolve("hello/data/user_note.json")
    assert hit_user is not None
    assert hit_user[1] == user_saved_file.resolve()

    print("  ✓ 内置胶囊数据写入持久化与隔离验证通过")


def main():
    test_capsules_list()
    test_toggle_capsule()
    test_system_capsule_data_persistence()
    print("\n🎉 全部胶囊优化功能自检通过！")


if __name__ == "__main__":
    try:
        main()
    finally:
        tmp_dir.cleanup()
