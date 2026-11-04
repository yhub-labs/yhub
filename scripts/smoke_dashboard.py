#!/usr/bin/env python3
"""信息墙后端契约冒烟 —— 一条命令跑完 api-contract.md §10.3 的 12 条 curl。

    python3 scripts/smoke_dashboard.py

覆盖：
  * 9 条正例（列表 / 过滤 / 分页 / 单格 / 快照列表 / 快照详情）全部 200
  * 3 条负例：400（参数非法）、404（不存在的格子）、405（写方法）
  * 契约级判据：11 个进屏字段齐全、三态与 staleness 枚举合法、R2（源不可达 ≠ ok）、
    R7（source 里不带查询串/用户信息）、适配器自动注册进 /api/tools
  * 快照真的落进了 ``YHUB_DASHBOARD_DIR``（临时目录，**不碰 ~/.config/yhub**）

后端由本脚本自己起（``uv run yhub gui --no-open --port <随机空闲端口>``），
跑完自己收干净。需要 ``web/dist`` 存在（uv 打包的 force-include 硬要求，见 docs/packaging.md）。
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
_reconfigure = getattr(sys.stdout, "reconfigure", None)
if callable(_reconfigure):
    _reconfigure(line_buffering=True)  # 与子进程直写的 ps/lsof 输出保持顺序
GATE_FIELDS = (
    "id", "title", "status", "summary", "updated_at", "href",
    "zone", "order", "enabled", "stale_after", "source",
)
STATUSES = ("ok", "warn", "alert")
ZONES = ("todo", "status")
STALENESSES = ("fresh", "stale", "expired")

_results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    _results.append((name, bool(ok), detail))
    mark = "PASS" if ok else "FAIL"
    suffix = f"   [{detail}]" if detail and not ok else ""
    print(f"  {mark}  {name}{suffix}")


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def curl(url: str, method: str = "GET") -> tuple[int, str]:
    """跑一条契约 curl，返回 (状态码, 响应体)。"""
    with tempfile.NamedTemporaryFile(suffix=".out", delete=False) as handle:
        out_path = handle.name
    try:
        proc = subprocess.run(
            [
                "curl", "-s", "--max-time", "60",
                "-o", out_path, "-w", "%{http_code}",
                "-X", method, url,
            ],
            capture_output=True, text=True,
        )
        code_text = (proc.stdout or "").strip()
        try:
            code = int(code_text)
        except ValueError:
            code = 0
        body = Path(out_path).read_text(encoding="utf-8", errors="replace")
        return code, body
    finally:
        Path(out_path).unlink(missing_ok=True)


def as_json(body: str):
    try:
        return json.loads(body)
    except Exception:
        return None


def _stat_of(path: Path) -> tuple[int, int] | None:
    try:
        info = path.stat()
    except OSError:
        return None
    return (info.st_mtime_ns, info.st_size)


def cells_by_ids(base: str, ids: list[str]) -> tuple[int, dict]:
    code, body = curl(base + "/api/dashboard/cells?ids=" + ",".join(ids))
    data = as_json(body) or {}
    return code, {c["id"]: c for c in (data.get("cells") or [])}


def wait_for_health(base: str, proc: subprocess.Popen, timeout: float) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            return False
        try:
            with socket.create_connection(("127.0.0.1", int(base.rsplit(":", 1)[1])), 1):
                code, body = curl(base + "/api/health")
                if code == 200 and as_json(body):
                    return True
        except OSError:
            pass
        time.sleep(0.5)
    return False


def main() -> int:
    if not (ROOT / "web" / "dist").is_dir():
        print("缺 web/dist（uv 打包的 force-include 硬要求）。先跑：")
        print("    cd web && npm install && npm run build")
        print("（全新 worktree 还要先 ln -s <主仓>/web/node_modules web/node_modules）")
        return 2

    port = int(os.environ.get("YHUB_SMOKE_PORT") or _free_port())
    base = f"http://127.0.0.1:{port}"
    workdir = Path(tempfile.mkdtemp(prefix="yhub-dashboard-smoke."))
    log_path = workdir / "server.log"
    env = {**os.environ, "YHUB_DASHBOARD_DIR": str(workdir)}
    # 测试用配置：只写临时目录。三个开关分别验证
    #   ① probe_url 覆盖 → source/href 跟着变（顺带造一个必然失败的端点）
    #   ② critical 源首次失败即 alert（契约 §8）
    #   ③ enabled=false 仍会出现在 API 里（契约 §3.4）
    smoke_config = {
        "cells": {
            "svc.demo1": {"probe_url": "http://127.0.0.1:9/"},
            "svc.demo2": {"critical": True},
            "sync.icloud-portfolio": {"enabled": False},
        },
        "snapshot_interval": 60,
    }
    (workdir / "dashboard.json").write_text(
        json.dumps(smoke_config, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    # 运行前后各看一眼真实用户目录，证明这一轮没有写到 ~/.config/yhub
    user_snapshot = Path.home() / ".config" / "yhub" / "dashboard" / "snapshots.jsonl"
    user_snapshot_stat = _stat_of(user_snapshot)

    print(f"配置/快照目录（临时，不碰 ~/.config/yhub）：{workdir}")
    print(f"后端：{base}\n")

    log_handle = log_path.open("w", encoding="utf-8")
    proc = subprocess.Popen(
        ["uv", "run", "yhub", "gui", "--no-open", "--port", str(port)],
        cwd=str(ROOT), env=env,
        stdout=log_handle, stderr=subprocess.STDOUT,
        start_new_session=True,
    )

    try:
        boot_timeout = float(os.environ.get("YHUB_SMOKE_BOOT_TIMEOUT") or 180)
        if not wait_for_health(base, proc, boot_timeout):
            print(f"  FAIL  后端没起来（{boot_timeout:g} s 内 /api/health 不通）")
            print(f"  子进程 poll = {proc.poll()}  pid = {proc.pid}")
            subprocess.run(["ps", "-o", "pid,ppid,stat,etime,command", "-p", str(proc.pid)])
            subprocess.run(["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN"])
            print(f"-------- {log_path} --------")
            print(log_path.read_text(encoding="utf-8", errors="replace")[-4000:])
            return 1

        # ---- 适配器自动注册（不改 yhub/server/main.py 的证据） ----------------
        code, body = curl(base + "/api/tools")
        tools = as_json(body) or {}
        ids = [t.get("id") for t in tools.get("tools", [])]
        check("适配器自动注册：/api/tools 里有 dashboard", code == 200 and "dashboard" in ids,
              f"code={code} ids={ids}")

        # ---- 1) 正例：格子列表（契约 §10.3 第 1 条） ---------------------
        print("\n正例（应全部 200）")
        code, body = curl(base + "/api/dashboard/cells")
        data = as_json(body) or {}
        cells = data.get("cells") or []
        check("GET /cells → 200", code == 200, f"code={code}")
        check("信封字段齐全（ok/generated_at/next_refresh_in/total/count）",
              data.get("ok") is True and isinstance(data.get("generated_at"), str)
              and isinstance(data.get("next_refresh_in"), int),
              str({k: data.get(k) for k in ('ok', 'generated_at', 'next_refresh_in')}))
        check("墙不空且 total/count 与数组自洽",
              len(cells) > 0 and data.get("total") == len(cells) and data.get("count") == len(cells),
              f"total={data.get('total')} count={data.get('count')} len={len(cells)}")

        missing_map = {
            c.get("id"): [f for f in GATE_FIELDS if f not in c or c[f] is None]
            for c in cells
        }
        gate_bad = [f"{cid}:{fields}" for cid, fields in missing_map.items() if fields]
        check("每格 11 个进屏字段齐全（R1）", not gate_bad, "; ".join(gate_bad))
        enum_bad = [
            c.get("id") for c in cells
            if c.get("status") not in STATUSES or c.get("zone") not in ZONES
            or c.get("staleness") not in STALENESSES
            or not isinstance(c.get("enabled"), bool) or not isinstance(c.get("stale_after"), int)
        ]
        check("status/zone/staleness/enabled/stale_after 枚举合法", not enum_bad, str(enum_bad))
        check("时间戳带 +08:00 偏移（Asia/Shanghai）",
              all(str(c.get("updated_at", "")).endswith("+08:00") for c in cells),
              str([c.get("updated_at") for c in cells if not str(c.get("updated_at", "")).endswith("+08:00")][:3]))
        check("summary 都 ≤ 80 字符",
              all(len(c.get("summary", "")) <= 80 for c in cells),
              str([len(c.get("summary", "")) for c in cells if len(c.get("summary", "")) > 80]))
        check("updated_at 不晚于 generated_at（age_seconds 非负且自洽）",
              all(c["updated_at"] <= data["generated_at"] and c["age_seconds"] >= 0 for c in cells),
              str([(c["id"], c["updated_at"], data["generated_at"]) for c in cells
                   if c["updated_at"] > data["generated_at"]][:3]))

        # 排序：zone（todo 在前）→ order → id
        zone_rank = {"todo": 0, "status": 1}
        keys = [(zone_rank[c["zone"]], c["order"], c["id"]) for c in cells]
        check("排序 = zone(todo 在前) → order → id", keys == sorted(keys), str(keys))

        # ---- 2~5) 过滤与分页 --------------------------------------------
        code, body = curl(base + "/api/dashboard/cells?zone=todo")
        data = as_json(body) or {}
        zone_cells = data.get("cells") or []
        check("GET /cells?zone=todo → 200 且全是 todo", code == 200 and all(c["zone"] == "todo" for c in zone_cells),
              f"code={code} n={len(zone_cells)}")

        code, body = curl(base + "/api/dashboard/cells?status=warn")
        data = as_json(body) or {}
        warn_cells = data.get("cells") or []
        check("GET /cells?status=warn → 200 且命中的全是 warn",
              code == 200 and all(c["status"] == "warn" for c in warn_cells),
              f"code={code} n={len(warn_cells)}")

        code, body = curl(base + "/api/dashboard/cells?staleness=expired")
        data = as_json(body) or {}
        expired_cells = data.get("cells") or []
        check("GET /cells?staleness=expired → 200 且命中的全是 expired",
              code == 200 and all(c["staleness"] == "expired" for c in expired_cells),
              f"code={code} n={len(expired_cells)}")

        code, body = curl(base + "/api/dashboard/cells?limit=3&offset=0")
        data = as_json(body) or {}
        check("GET /cells?limit=3&offset=0 → 200 且 count ≤ 3 ≤ total",
              code == 200 and data.get("count", 0) <= 3 and data.get("total", 0) >= data.get("count", 0),
              f"code={code} total={data.get('total')} count={data.get('count')}")

        # ---- 6) 单格 ------------------------------------------------------
        code, body = curl(base + "/api/dashboard/cells/overview.alerts")
        data = as_json(body) or {}
        cell = data.get("cell") or {}
        check("GET /cells/overview.alerts → 200 且 id 对得上",
              code == 200 and cell.get("id") == "overview.alerts", f"code={code}")

        # ---- R2 / R7 判据（就地用全量响应验） -----------------------------
        code, body = curl(base + "/api/dashboard/cells")
        all_cells = (as_json(body) or {}).get("cells") or []
        offenders = [c["id"] for c in all_cells if c.get("source_error") and c["status"] == "ok"]
        check("R2：source_error 非 null 的格子绝不许是 ok", not offenders, str(offenders))
        query_sources = [c["id"] for c in all_cells
                         if "?" in str(c.get("source", "")) or "@" in str(c.get("source", ""))]
        check("R7：source 不带查询串/用户信息", not query_sources, str(query_sources))
        overview = next((c for c in all_cells if c["id"] == "overview.alerts"), None)
        check("R6：聚合格存在且有 summary/detail/href",
              overview is not None and isinstance(overview.get("detail"), list)
              and overview.get("href") not in (None, ""),
              str(overview and overview.get("summary")))

        # ---- §6.5 判据：聚合格 detail 一条一格，不许被 DETAIL_LIMIT 截断 ----------
        if overview and overview.get("status") != "ok":
            head = str(overview.get("summary", "")).split("格", 1)[0].strip()
            try:
                n_summary = int(head)
            except ValueError:
                n_summary = -1
            detail_list = overview.get("detail") or []
            check("§6.5：summary 的「N 格异常」== detail 条数",
                  n_summary == len(detail_list),
                  f"summary={overview.get('summary')!r} detail={len(detail_list)}")
            flagged_titles = [c["title"] for c in all_cells
                              if c["id"] != "overview.alerts" and c.get("enabled")
                              and (c["status"] != "ok" or c.get("staleness") != "fresh")]
            missed = [t for t in flagged_titles
                      if not any(str(d.get("text", "")).startswith(t) for d in detail_list)]
            check("§6.5：每个异常格都在 detail 里点到名", not missed, str(missed))

        # ---- 7~8) 快照列表 ------------------------------------------------
        print("\n历史快照")
        code, body = curl(base + "/api/dashboard/snapshots?limit=5")
        data = as_json(body) or {}
        snaps = data.get("snapshots") or []
        check("GET /snapshots?limit=5 → 200", code == 200, f"code={code}")
        check("首屏之后已经落了一期快照（YHUB_DASHBOARD_DIR 生效）",
              len(snaps) >= 1, f"n={len(snaps)}")
        check("快照行只带 5 个元字段（不含 cells）",
              all(set(s) == {"id", "captured_at", "cell_count", "totals", "flagged"} for s in snaps),
              str([sorted(s) for s in snaps[:1]]))
        check("快照 id 形如 sn_YYYYMMDDTHHMMSS 且新→旧",
              all(s["id"].startswith("sn_") for s in snaps)
              and [s["id"] for s in snaps] == sorted((s["id"] for s in snaps), reverse=True),
              str([s["id"] for s in snaps[:3]]))

        code, body = curl(base + "/api/dashboard/snapshots?flagged=true")
        data = as_json(body) or {}
        flagged = data.get("snapshots") or []
        check("GET /snapshots?flagged=true → 200 且命中的都 flagged",
              code == 200 and all(s.get("flagged") for s in flagged), f"code={code} n={len(flagged)}")

        # ---- 9) 快照详情（用列表里真实存在的 id，别写死一个历史 id） --------
        latest = snaps[0]["id"] if snaps else None
        if latest:
            code, body = curl(base + f"/api/dashboard/snapshots/{latest}")
            data = as_json(body) or {}
            snap = data.get("snapshot") or {}
            check("GET /snapshots/{id} → 200 且带完整格子数组",
                  code == 200 and isinstance(snap.get("cells"), list) and len(snap.get("cells", [])) > 0,
                  f"code={code} n={len(snap.get('cells') or [])}")
            totals = snap.get("totals") or {}
            check("totals 之和 == cell_count",
                  sum(totals.values()) == snap.get("cell_count"),
                  f"totals={totals} cell_count={snap.get('cell_count')}")
        else:
            check("GET /snapshots/{id} → 200 且带完整格子数组", False, "没有可用的快照 id")

        # ---- 10~12) 负例（400 / 404 / 405） -------------------------------
        print("\n负例（应分别 400 / 404 / 405）")
        code, body = curl(base + "/api/dashboard/cells?zone=todoo")
        data = as_json(body) or {}
        check("400：?zone=todoo → 400 + 标准错误体",
              bool(code == 400 and data.get("ok") is False and data.get("error") and data.get("hint")),
              f"code={code} body={body[:160]}")
        check("400 文案与契约 §7.5 一致",
              data.get("error") == "不支持的 zone：todoo" and data.get("hint") == "zone 只能是 todo 或 status",
              str(data))

        code, body = curl(base + "/api/dashboard/cells/nope")
        data = as_json(body) or {}
        check("404：/cells/nope → 404 + 标准错误体",
              bool(code == 404 and data.get("ok") is False and data.get("error") and data.get("hint")),
              f"code={code} body={body[:160]}")

        code, body = curl(base + "/api/dashboard/cells", method="POST")
        check("405：POST /cells → 405（Starlette 兜底，判据是状态码）", code == 405, f"code={code}")

        # ---- 配置覆盖（另一个 400 正身 + 边界参数） -----------------------
        print("\n参数边界")
        for query, desc in (
            ("?limit=0", "limit=0 → 400"),
            ("?limit=201", "limit=201 → 400"),
            ("?limit=abc", "limit=abc → 400"),
            ("?offset=-1", "offset=-1 → 400"),
            ("?enabled=maybe", "enabled=maybe → 400"),
            ("?staleness=freshish", "staleness=freshish → 400"),
        ):
            code, _body = curl(base + "/api/dashboard/cells" + query)
            check(desc, code == 400, f"code={code}")

        code, body = curl(base + "/api/dashboard/cells?ids=" + ",".join(f"c{i}" for i in range(60)))
        check("ids 超过 50 个 → 400", code == 400, f"code={code}")

        # ---- 源不可达的三态（R2 + 契约 §8 的 critical） -------------------
        print("\n源不可达的三态")
        _code, first = cells_by_ids(
            base, ["svc.demo2", "tasks.today", "svc.demo1", "sync.icloud-portfolio"]
        )
        check("critical 源首次失败即 alert（svc.demo2）",
              first.get("svc.demo2", {}).get("status") == "alert",
              str(first.get("svc.demo2", {}).get("summary")))
        check("非关键源首次失败只 warn（tasks.today：SP 没在跑）",
              first.get("tasks.today", {}).get("status") == "warn",
              str(first.get("tasks.today", {}).get("summary")))
        failed = first.get("svc.demo1", {})
        check("失败格带人话 source_error，且不是 ok",
              bool(failed.get("source_error")) and failed.get("status") in ("warn", "alert"),
              str(failed.get("source_error")))
        check("probe_url 覆盖后 source/href 跟着变（§6.3）",
              failed.get("source") == "probe:http://127.0.0.1:9/"
              and failed.get("href") == "http://127.0.0.1:9/",
              f"source={failed.get('source')} href={failed.get('href')}")
        check("失败格 last_attempt_at 在走、updated_at 没被推着走（R3）",
              bool(failed.get("updated_at")) and bool(failed.get("last_attempt_at")),
              str({k: failed.get(k) for k in ("updated_at", "last_attempt_at")}))
        check("关掉的格子仍出现在 API 里（§3.4）",
              first.get("sync.icloud-portfolio", {}).get("enabled") is False,
              str(first.get("sync.icloud-portfolio")))

        _code, body = curl(base + "/api/dashboard/cells?enabled=false")
        off = (as_json(body) or {}).get("cells") or []
        check("?enabled=false 只剩被关掉的格子",
              [c["id"] for c in off] == ["sync.icloud-portfolio"], str([c["id"] for c in off]))
        _code, body = curl(base + "/api/dashboard/cells?enabled=true")
        on = (as_json(body) or {}).get("cells") or []
        check("?enabled=true 不含被关掉的格子",
              bool(on) and all(c["id"] != "sync.icloud-portfolio" for c in on), str(len(on)))

        # 探测组 TTL 30 s：等它刷第二轮，验证「连续失败 ≥ 2 → alert」
        print("\n等探测组第二轮刷新（35 s，验证连续失败升级）…")
        time.sleep(35)
        _code, second = cells_by_ids(base, ["svc.demo1"])
        check("连续失败 ≥ 2 → alert（svc.demo1）",
              second.get("svc.demo1", {}).get("status") == "alert",
              str(second.get("svc.demo1", {}).get("summary")))

        # ---- 落盘位置 -----------------------------------------------------
        snap_path = workdir / "dashboard" / "snapshots.jsonl"
        check("快照落在 YHUB_DASHBOARD_DIR/dashboard/snapshots.jsonl", snap_path.is_file(), str(snap_path))
        check("真实用户目录 ~/.config/yhub/dashboard 这一轮没被动过",
              _stat_of(user_snapshot) == user_snapshot_stat,
              f"{user_snapshot} 运行前后不一致")

    finally:
        _stop(proc, log_handle)

    failed = [name for name, ok, _ in _results if not ok]
    print(f"\n{len(_results) - len(failed)}/{len(_results)} 项通过")
    if failed:
        print("失败项：")
        for name in failed:
            print(f"  - {name}")
        print(f"服务端日志：{log_path}")
        return 1
    shutil.rmtree(workdir, ignore_errors=True)
    return 0


def _stop(proc: subprocess.Popen, log_handle) -> None:
    if proc.poll() is None:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except (ProcessLookupError, PermissionError, OSError):
            proc.terminate()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except (ProcessLookupError, PermissionError, OSError):
                proc.kill()
    log_handle.close()


if __name__ == "__main__":
    sys.exit(main())
