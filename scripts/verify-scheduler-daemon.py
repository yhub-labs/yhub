#!/usr/bin/env python3
"""验证定时任务系统级常驻服务模块与跨进程互斥锁。

不弄脏用户环境：通过临时目录与隔离环境变量运行。
"""

from __future__ import annotations

import os
import sys
import tempfile
import threading
from pathlib import Path
from unittest.mock import MagicMock, patch

# 隔离配置目录
tmp_dir = tempfile.TemporaryDirectory()
os.environ["YHUB_SCHEDULE_DIR"] = str(Path(tmp_dir.name) / "config")
os.environ["YHUB_LAUNCHD_DIR"] = str(Path(tmp_dir.name) / "launchd")
os.environ["YHUB_SYSTEMD_DIR"] = str(Path(tmp_dir.name) / "systemd")

from yhub.server.adapters import _scheduler as sched
from yhub.server.adapters import _scheduler_daemon as daemon


def test_resolve_command():
    print("▶ 1. 验证目标命令路径解析")
    # 显式覆盖
    cmd = daemon.resolve_target_command(["my-yhub", "schedule", "tick"])
    assert cmd == ["my-yhub", "schedule", "tick"], f"意外的目标命令: {cmd}"

    # 环境变量覆盖
    with patch.dict(os.environ, {"YHUB_DAEMON_CMD": "/custom/bin/yhub schedule tick"}):
        cmd = daemon.resolve_target_command()
        assert cmd == ["/custom/bin/yhub", "schedule", "tick"], f"环境变量解析失败: {cmd}"

    # 默认解析必须给出可执行列表，且最后两个参数为 schedule tick
    cmd = daemon.resolve_target_command()
    assert len(cmd) >= 3 and cmd[-2:] == ["schedule", "tick"], f"命令格式不符合要求: {cmd}"
    print("  ✓ 目标命令路径解析通过")


def test_tick_lock():
    print("▶ 2. 验证 tick 锁互斥防重入")
    # 模拟第一个 tick 正在执行
    with sched._tick_lock() as acq1:
        assert acq1 is True, "首个锁应该成功获取"

        # 并发获取应该失败（排他锁生效）
        with sched._tick_lock() as acq2:
            assert acq2 is False, "已有 tick 在跑时，后续 tick 必须获取失败以防重入"

    # 释放后重新获取应该成功
    with sched._tick_lock() as acq3:
        assert acq3 is True, "锁释放后应该能够再次获取"

    print("  ✓ tick 锁互斥防重入通过")


def test_darwin_daemon():
    print("▶ 3. 验证 macOS (launchd) 配置生成与解析")
    with patch("yhub.server.adapters._scheduler_daemon._run_cmd") as mock_run:
        mock_run.return_value = MagicMock(returncode=0, stdout="", stderr="")

        res = daemon._DarwinDaemon.install(["/usr/local/bin/yhub", "schedule", "tick"])
        assert res["ok"] is True, f"DarwinDaemon install 失败: {res}"
        plist = daemon._DarwinDaemon.plist_path()
        assert plist.is_file(), f"plist 未生成: {plist}"

        content = plist.read_text(encoding="utf-8")
        assert "com.yhub.scheduler" in content
        assert "/usr/local/bin/yhub" in content
        assert "<integer>60</integer>" in content
        assert "StandardOutPath" in content

        # 状态检查
        status = daemon._DarwinDaemon.status()
        assert status["installed"] is True
        assert status["platform"] == "darwin"
        assert status["backend"] == "launchd"
        assert status["target"] == ["/usr/local/bin/yhub", "schedule", "tick"]

        # 卸载
        un_res = daemon._DarwinDaemon.uninstall()
        assert un_res["ok"] is True
        assert not plist.is_file(), "卸载后 plist 文件应被删除"

    print("  ✓ macOS (launchd) 逻辑通过")


def test_linux_daemon():
    print("▶ 4. 验证 Linux (systemd & crontab) 生成与降级")
    # 1. systemd
    with patch.object(daemon._LinuxDaemon, "has_systemd_user", return_value=True), \
         patch("yhub.server.adapters._scheduler_daemon._run_cmd") as mock_run:
        mock_run.return_value = MagicMock(returncode=0, stdout="active", stderr="")

        res = daemon._LinuxDaemon.install(["/usr/bin/yhub", "schedule", "tick"])
        assert res["ok"] is True, f"Linux systemd install 失败: {res}"
        s_path = daemon._LinuxDaemon.service_path()
        t_path = daemon._LinuxDaemon.timer_path()
        assert s_path.is_file(), "service 文件未生成"
        assert t_path.is_file(), "timer 文件未生成"

        assert "OnUnitActiveSec=1m" in t_path.read_text(encoding="utf-8")
        assert "Type=oneshot" in s_path.read_text(encoding="utf-8")

        status = daemon._LinuxDaemon.status()
        assert status["installed"] is True
        assert status["backend"] == "systemd"

        daemon._LinuxDaemon.uninstall()
        assert not s_path.is_file() and not t_path.is_file(), "卸载后单元文件应被清理"

    # 2. crontab fallback
    with patch.object(daemon._LinuxDaemon, "has_systemd_user", return_value=False), \
         patch("yhub.server.adapters._scheduler_daemon._run_cmd") as mock_run, \
         patch("subprocess.run") as mock_sp_run:
        mock_run.return_value = MagicMock(returncode=0, stdout="* * * * * echo hello\n", stderr="")
        mock_sp_run.return_value = MagicMock(returncode=0, stdout="", stderr="")

        res = daemon._LinuxDaemon.install(["/usr/bin/yhub", "schedule", "tick"])
        assert res["ok"] is True, f"Linux crontab install 失败: {res}"
        written_crontab = mock_sp_run.call_args[1].get("input", "")
        assert daemon._LinuxDaemon.CRON_TAG in written_crontab
        assert "* * * * *" in written_crontab

    print("  ✓ Linux (systemd & crontab) 逻辑通过")


def test_windows_daemon():
    print("▶ 5. 验证 Windows (schtasks) 调度生成")
    with patch("yhub.server.adapters._scheduler_daemon._run_cmd") as mock_run:
        mock_run.return_value = MagicMock(returncode=0, stdout="SUCCESS", stderr="")

        res = daemon._WindowsDaemon.install(["C:\\Program Files\\Y-Hub\\yhub.exe", "schedule", "tick"])
        assert res["ok"] is True, f"Windows install 失败: {res}"
        call_args = mock_run.call_args[0][0]
        assert "schtasks" in call_args
        assert "/sc" in call_args and "minute" in call_args
        assert "/mo" in call_args and "1" in call_args
        assert daemon.TASK_NAME in call_args

        # 卸载
        un_res = daemon._WindowsDaemon.uninstall()
        assert un_res["ok"] is True

    print("  ✓ Windows (schtasks) 逻辑通过")


def main():
    test_resolve_command()
    test_tick_lock()
    test_darwin_daemon()
    test_linux_daemon()
    test_windows_daemon()
    print("\n🎉 全部定时常驻模块断言通过！")


if __name__ == "__main__":
    try:
        main()
    finally:
        tmp_dir.cleanup()
