#!/usr/bin/env python3
"""Every Chinese string a tool declares must have an English counterpart.

`TOOL_META` and `plugin.json` declare display text in Chinese and `yhub.i18n.tr_text`
maps it through `TEXT_EN` (`yhub/locales/display.py`). A missing entry is silent: the
English UI gets Chinese. This script walks the **loaded** declarations (tool name /
description / status, wall tile titles, route + MCP parameter help, MCP tool
descriptions) and asserts every Chinese string resolves.

Keywords are exempt on purpose: they are bilingual search tokens (`挂载 mount`), not
display text.

Run it with an isolated config root; it is read-only otherwise.
"""

from __future__ import annotations

import os
import re
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)

CJK = re.compile(r"[\u4e00-\u9fff]")
#: fields whose values are identifiers / search tokens / code names, never display text
SKIP_KEYS = {"id", "icon", "keywords", "handler", "endpoint", "fetch", "path", "method",
             "name_in_code", "type", "in", "source", "group"}
#: fields that never hold prose (numeric / structural)
SKIP_TYPES = (int, float, bool, type(None))


def _walk(value, where, out):
    if isinstance(value, str):
        if CJK.search(value):
            out.append((where, value))
        return
    if isinstance(value, SKIP_TYPES):
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if key in SKIP_KEYS:
                continue
            _walk(item, f"{where}.{key}", out)
        return
    if isinstance(value, (list, tuple)):
        for index, item in enumerate(value):
            _walk(item, f"{where}[{index}]", out)


def main() -> int:
    os.environ.setdefault("YHUB_CONFIG_DIR", tempfile.mkdtemp(prefix="yhub-i18n-"))
    os.environ["YHUB_LANG"] = "en"
    from yhub.i18n import tr_text
    from yhub.server.adapters import discover_adapters

    problems: list[tuple[str, str]] = []
    checked = 0
    for entry in discover_adapters():
        meta = entry["meta"]
        found: list[tuple[str, str]] = []
        _walk(meta, str(meta.get("id", "?")), found)
        for where, text in found:
            checked += 1
            if tr_text(text) == text:
                problems.append((where, text))

    for where, text in problems:
        print(f"FAIL  {where}: {text[:90]}")
    total = checked + len(problems)  # `checked` already counts the failures; keep the message honest
    if problems:
        print(f"\nFAIL  {len(problems)} Chinese display string(s) without a TEXT_EN entry")
        print("      add them to yhub/locales/display.py")
        return 1
    print(f"PASS  display strings: {checked} checked, every Chinese string resolves in English")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
