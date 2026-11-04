import CoreGraphics
import Foundation

// 探针：把属于 Y-Hub 的窗口打成单行、便于机器解析
// 输出形如：W owner=Y-Hub onscreen=1 layer=5 alpha=1 x=660 y=576 w=720 h=480
func report(_ opts: CGWindowListOption, _ tag: String) {
    let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] ?? []
    for w in list {
        let owner = w[kCGWindowOwnerName as String] as? String ?? "?"
        guard owner.lowercased().contains("yhub") else { continue }
        let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
        let onscreen = (w[kCGWindowIsOnscreen as String] as? Bool) == true ? 1 : 0
        let layer = w[kCGWindowLayer as String] as? Int ?? -999
        let alpha = w[kCGWindowAlpha as String] as? Double ?? -1
        let x = b["X"] as? Double ?? -1
        let y = b["Y"] as? Double ?? -1
        let ww = b["Width"] as? Double ?? -1
        let hh = b["Height"] as? Double ?? -1
        print("W tag=\(tag) owner=\(owner) onscreen=\(onscreen) layer=\(layer) alpha=\(alpha) x=\(Int(x)) y=\(Int(y)) w=\(Int(ww)) h=\(Int(hh))")
    }
}
report([.optionOnScreenOnly, .excludeDesktopElements], "onscreen")
report([.optionAll], "all")
