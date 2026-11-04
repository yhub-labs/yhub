Y-Hub @VERSION@
==============

This disk image contains the macOS shell only. The backend is Python and is NOT bundled.

1) Install the backend first — once, and again after each upgrade:

     uv tool install yhub        # or: pip install yhub
     yhub --version

2) Drag Y-Hub.app into Applications.

3) First launch: macOS says the app "is damaged". It is not. This build is ad-hoc
   signed and not notarized (no paid Apple Developer certificate), so Gatekeeper
   blocks it. Either right-click the app → Open → Open, or run:

     xattr -dr com.apple.quarantine /Applications/Y-Hub.app

4) Check the download before opening it:

     shasum -a 256 Y-Hub_@VERSION@_aarch64.dmg

   Compare it with the .sha256 file attached to the same GitHub release.

Notes
  - Apple Silicon only (aarch64).
  - The shell listens on 127.0.0.1:8790 and has no authentication. Do not expose it
    to a network.
  - Source, documentation and the Python package: https://github.com/yhub-labs/yhub


--------------------------------- 中文 ---------------------------------

Y-Hub @VERSION@

这个磁盘映像里只有 macOS 外壳，Python 后端**不在**包里。

1) 先装后端（第一次，以及每次升级后都要）：

     uv tool install yhub        # 或 pip install yhub
     yhub --version

2) 把 Y-Hub.app 拖进「应用程序」。

3) 首次打开时系统会提示"已损坏"。文件是好的 —— 本构建是 ad-hoc 签名、未公证
   （没有付费的 Apple 开发者证书），Gatekeeper 会拦。两种处理：

     · 右键点 App → 打开 → 再点「打开」
     · 或执行：xattr -dr com.apple.quarantine /Applications/Y-Hub.app

4) 打开前建议校验下载：

     shasum -a 256 Y-Hub_@VERSION@_aarch64.dmg

   与同一次 GitHub Release 里的 .sha256 文件对比。

说明
  - 仅 Apple Silicon（aarch64）。
  - 外壳只监听 127.0.0.1:8790，且没有鉴权，不要暴露到网络。
  - 源码、文档与 Python 包：https://github.com/yhub-labs/yhub
