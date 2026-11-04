#!/usr/bin/env python3
"""问窗口服务器（WindowServer）：「这个 pid 现在屏幕上有没有窗口？」——给验证脚本用的硬判据。

为什么不用截图：面板可能被别的窗口（比如全屏的 Chrome）挡在后面 —— 截图看不见 ≠ 没显示，
也不能自动化判断。`kCGWindowListOptionOnScreenOnly` 返回的是**窗口服务器真正合成到屏幕上的**
窗口列表（含被挡住的），所以「pid 在不在这个列表里」就是「屏幕上有没有它的面板」。

实现：ctypes 直接调 CoreGraphics / CoreFoundation，不依赖 pyobjc（本机没有，也不想为验证装依赖）。

用法：
    onscreen-windows.py                     # 列出屏幕上所有窗口（JSON）
    onscreen-windows.py --all               # 连离屏窗口一起列（对照用）
    onscreen-windows.py --pid 1234          # 只看某个 pid：第一行 yes/no，后面是它的窗口
    onscreen-windows.py --owner yhub      # 只看某个进程名的窗口
"""
import ctypes
import json
import sys

CG = "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics"
CF = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation"

kCGWindowListOptionAll = 0
kCGWindowListOptionOnScreenOnly = 1
kCGWindowListExcludeDesktopElements = 16
kCGNullWindowID = 0
kCFStringEncodingUTF8 = 0x08000100
kCFNumberSInt64Type = 4

cg = ctypes.CDLL(CG)
cf = ctypes.CDLL(CF)

cg.CGWindowListCopyWindowInfo.restype = ctypes.c_void_p
cg.CGWindowListCopyWindowInfo.argtypes = [ctypes.c_uint32, ctypes.c_uint32]
cf.CFArrayGetCount.restype = ctypes.c_long
cf.CFArrayGetCount.argtypes = [ctypes.c_void_p]
cf.CFArrayGetValueAtIndex.restype = ctypes.c_void_p
cf.CFArrayGetValueAtIndex.argtypes = [ctypes.c_void_p, ctypes.c_long]
cf.CFDictionaryGetValue.restype = ctypes.c_void_p
cf.CFDictionaryGetValue.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
cf.CFStringCreateWithCString.restype = ctypes.c_void_p
cf.CFStringCreateWithCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_uint32]
cf.CFStringGetCString.restype = ctypes.c_bool
cf.CFStringGetCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_long, ctypes.c_uint32]
cf.CFNumberGetValue.restype = ctypes.c_bool
cf.CFNumberGetValue.argtypes = [ctypes.c_void_p, ctypes.c_long, ctypes.c_void_p]
cf.CFGetTypeID.restype = ctypes.c_ulong
cf.CFGetTypeID.argtypes = [ctypes.c_void_p]
cf.CFStringGetTypeID.restype = ctypes.c_ulong
cf.CFNumberGetTypeID.restype = ctypes.c_ulong
cf.CFRelease.argtypes = [ctypes.c_void_p]

KEYS = ("kCGWindowOwnerName", "kCGWindowOwnerPID", "kCGWindowName", "kCGWindowLayer", "kCGWindowAlpha")


def _cfstr(text):
    return cf.CFStringCreateWithCString(None, text.encode("utf-8"), kCFStringEncodingUTF8)


def _as_str(ref):
    if not ref or cf.CFGetTypeID(ref) != cf.CFStringGetTypeID():
        return None
    buf = ctypes.create_string_buffer(1024)
    if not cf.CFStringGetCString(ref, buf, 1024, kCFStringEncodingUTF8):
        return None
    return buf.value.decode("utf-8", "replace")


def _as_int(ref):
    if not ref or cf.CFGetTypeID(ref) != cf.CFNumberGetTypeID():
        return None
    out = ctypes.c_int64(0)
    if not cf.CFNumberGetValue(ref, kCFNumberSInt64Type, ctypes.byref(out)):
        return None
    return out.value


def windows(on_screen_only=True):
    option = kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements if on_screen_only else kCGWindowListOptionAll
    arr = cg.CGWindowListCopyWindowInfo(option, kCGNullWindowID)
    if not arr:
        return []
    keys = {name: _cfstr(name) for name in KEYS}
    rows = []
    for i in range(cf.CFArrayGetCount(arr)):
        d = cf.CFArrayGetValueAtIndex(arr, i)
        rows.append(
            {
                "owner": _as_str(cf.CFDictionaryGetValue(d, keys["kCGWindowOwnerName"])),
                "pid": _as_int(cf.CFDictionaryGetValue(d, keys["kCGWindowOwnerPID"])),
                "name": _as_str(cf.CFDictionaryGetValue(d, keys["kCGWindowName"])),
                "layer": _as_int(cf.CFDictionaryGetValue(d, keys["kCGWindowLayer"])),
                "alpha": _as_int(cf.CFDictionaryGetValue(d, keys["kCGWindowAlpha"])),
            }
        )
    for k in keys.values():
        cf.CFRelease(k)
    cf.CFRelease(arr)
    return rows


def main():
    args = sys.argv[1:]
    rows = windows(on_screen_only="--all" not in args)
    if "--pid" in args:
        want = int(args[args.index("--pid") + 1])
        hits = [r for r in rows if r["pid"] == want]
        print("yes" if hits else "no")
        for r in hits:
            print(json.dumps(r, ensure_ascii=False))
        return
    if "--owner" in args:
        want = args[args.index("--owner") + 1].lower()
        rows = [r for r in rows if (r["owner"] or "").lower() == want]
    print(json.dumps(rows, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
