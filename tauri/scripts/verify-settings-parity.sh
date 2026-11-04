#!/usr/bin/env bash
#
# 守住设置契约：`tauri/src/config.rs`（Rust，壳）与 `yhub/server/adapters/settings.py`（Python，后端/CLI）
# 必须认识**同一套键**：两份实现各自读写同一份 `settings.json`，键目录或枚举一旦分叉，
# 症状是「壳里保存一次，某个键就被悄悄抹掉」或者「CLI 设得进去、壳说未知设置项」——
# 都是没人会立刻发现的那种坏。这个脚本不需要 Rust 工具链：它只读源码文本。
#
#   ./tauri/scripts/verify-settings-parity.sh
#
# 退出码 0 = 一致；1 = 有分叉（逐条打印）。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RS="$REPO_ROOT/tauri/src/config.rs"
PYMOD="$REPO_ROOT/yhub/server/adapters/settings.py"

[ -f "$RS" ] || { echo "找不到 $RS" >&2; exit 1; }
[ -f "$PYMOD" ] || { echo "找不到 $PYMOD" >&2; exit 1; }

PY="$(command -v python3)"
[ -n "$PY" ] || { echo "找不到 python3" >&2; exit 1; }

"$PY" - "$RS" "$PYMOD" <<'PY'
import ast
import re
import sys

rs_path, py_path = sys.argv[1], sys.argv[2]
rs = open(rs_path, encoding="utf-8").read()
py = open(py_path, encoding="utf-8").read()

failed = []


def check(name: str, rust_value, py_value) -> None:
    ok = rust_value == py_value
    print(f"{'PASS' if ok else 'FAIL'}  {name}")
    if not ok:
        print(f"      Rust  : {rust_value}")
        print(f"      Python: {py_value}")
        failed.append(name)


def rust_const(name: str) -> str:
    """取 `pub const NAME: &str = "…";` 的字面量"""
    match = re.search(rf'pub const {name}\s*:\s*&str\s*=\s*"([^"]*)"', rs)
    return match.group(1) if match else None


def rust_number(name: str) -> int:
    match = re.search(rf"pub const {name}\s*:\s*u32\s*=\s*(\d+)", rs)
    return int(match.group(1)) if match else None


def rust_list(name: str) -> list:
    """取 `pub const NAME: &[&str] = &[ "a", "b" ];` 的字符串列表"""
    match = re.search(rf"pub const {name}\s*:\s*&\[&str\]\s*=\s*&\[(.*?)\];", rs, re.S)
    if not match:
        return None
    return re.findall(r'"([^"]*)"', match.group(1))


def rust_hotkey_actions() -> list:
    """取 HOTKEY_ACTIONS 里的 (id 常量名, default_combo)"\" ; id 是 ACTION_* 常量，转成字面量"""
    block = re.search(r"pub const HOTKEY_ACTIONS[^=]*=\s*&\[(.*?)\];", rs, re.S)
    if not block:
        return None
    out = []
    for entry in re.finditer(r"HotkeyAction\s*\{(.*?)\}", block.group(1), re.S):
        body = entry.group(1)
        action = re.search(r"id:\s*(ACTION_[A-Z_]+)", body)
        combo = re.search(r'default_combo:\s*(?:"([^"]*)"|([A-Z_]+))', body)
        if not action or not combo:
            continue
        combo_value = combo.group(1) if combo.group(1) is not None else rust_const(combo.group(2))
        action_const = rust_const(action.group(1))
        out.append((action_const, combo_value))
    return out


# Python 侧：把模块当纯数据读（不 import，免得拉起 FastAPI 依赖）。
# 两步走：先收「字面量常量」，再把引用这些常量的表达式（`{"id": ..., "default_combo": DEFAULT_HOTKEY}`）
# 用已收到的值代进去 —— 否则 HOTKEY_ACTIONS / KNOWLEDGE_DEFAULTS 这类会解析失败、被当成「不存在」。
tree = ast.parse(py)
nodes = []
values = {}


class _Resolve(ast.NodeTransformer):
    def visit_Name(self, node: ast.Name):
        return ast.Constant(value=values[node.id]) if node.id in values else node


for node in tree.body:
    target = None
    if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
        target = node.targets[0].id
    elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.value is not None:
        target = node.target.id  # 带类型标注的赋值（`TRAY_DEFAULTS: dict[str, Any] = {...}`）也要认
    if target is None:
        continue
    nodes.append((target, node.value))

for _ in range(2):  # 第二遍解析引用前面常量的那些
    for target, value in nodes:
        try:
            values[target] = ast.literal_eval(_Resolve().visit(ast.parse(ast.unparse(value)).body[0].value))
        except (ValueError, SyntaxError, KeyError):
            pass

check("SETTINGS_VERSION", rust_number("SETTINGS_VERSION"), values.get("SETTINGS_VERSION"))
check("DEFAULT_HOTKEY", rust_const("DEFAULT_HOTKEY"), values.get("DEFAULT_HOTKEY"))
check("TRAY_FIELDS", rust_list("TRAY_FIELDS"), values.get("TRAY_FIELDS"))
check("CLOSE_BEHAVIORS", rust_list("CLOSE_BEHAVIORS"), values.get("CLOSE_BEHAVIORS"))
check("CLICK_BEHAVIORS", rust_list("CLICK_BEHAVIORS"), values.get("CLICK_BEHAVIORS"))

py_actions = [(a["id"], a["default_combo"]) for a in values.get("HOTKEY_ACTIONS", [])]
check("HOTKEY_ACTIONS（id + 默认组合键）", rust_hotkey_actions(), py_actions)

def _strip_comments(kind: str, text: str) -> str:
    if kind == "rust":
        return re.sub(r"^\s*//.*$", "", text, flags=re.M)
    body = re.sub(r'""".*?"""', "", text, flags=re.S)
    return re.sub(r"#.*$", "", body)


def _tokens(text: str) -> list[str]:
    return [re.sub(r"\{[^}]*\}", "", lit) for lit in re.findall(r'"([^"]*)"', text) if lit]


def rust_known_keys():
    m = re.search(r"pub fn known_keys\(\)[^{]*\{(.*?)\n\}", rs, re.S)
    return _tokens(_strip_comments("rust", m.group(1))) if m else None


def py_known_keys():
    m = re.search(r"(?:^def known_keys\(\).*?:)(.*?)(?:^    return keys)", py, re.S | re.M)
    return _tokens(_strip_comments("python", m.group(1))) if m else None


# 键目录：壳只拥有启动必需的 hotkeys/tray；capsules_* 与 plugins 归 Python 后端。
rs_keys = rust_known_keys() or []
py_keys = py_known_keys() or []
shell_keys = [k for k in rs_keys if k == "version" or k.startswith("hotkeys") or k.startswith("tray")]
non_shell = [k for k in rs_keys if k not in shell_keys]
check("Rust 键目录只含 hotkeys/tray 相关项", non_shell, [])
missing = [k for k in rs_keys if k not in py_keys]
check("Python 认识壳拥有的每一个键", missing, [])
for label, key in (("capsules_dir", "capsules_dir"), ("plugins 段", "plugins")):
    print(f"{'PASS' if key in py_keys else 'FAIL'}  Python 侧拥有 {label}")
    if key not in py_keys:
        failed.append(f"Python.{key}")
for key in ("capsules_dir", "plugins"):
    if key in rs_keys:
        print(f"FAIL  Rust 不应再拥有 {key}（应走后端 /api/settings）")
        failed.append(f"Rust.{key}")
    else:
        print(f"PASS  Rust 不再拥有 {key}（后端单一真源）")

# 托盘的默认值也要一致（只比键与类型，不比实现）
py_tray_defaults = values.get("TRAY_DEFAULTS", {})
rs_tray_defaults = {}
block = re.search(r"impl Default for TraySettings\s*\{\s*fn default\(\) -> Self \{(.*?)\n    \}", rs, re.S)
if block:
    for match in re.finditer(r'(\w+):\s*(?:"([^"]*)"|(true|false))', block.group(1)):
        rs_tray_defaults[match.group(1)] = match.group(2) if match.group(2) is not None else match.group(3) == "true"
check("TraySettings 默认值", rs_tray_defaults, py_tray_defaults)

if failed:
    print(f"\n{len(failed)} 项分叉：{failed}")
    print("两侧必须同时改：tauri/src/config.rs 与 yhub/server/adapters/settings.py（见 docs/config.md）")
    sys.exit(1)
print("\n设置契约一致：Rust（壳）与 Python（后端/CLI）认识同一套键")
PY
